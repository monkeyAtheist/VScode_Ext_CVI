import * as fs from 'fs';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';
import * as vscode from 'vscode';
import { CviParser } from '../model/cviParser';
import { CviBuildMode, CviWorkspaceProjectRef } from '../model/types';
import { CviWorkspaceService } from './cviWorkspaceService';

export interface CviRunSettings {
  arguments: string;
  workingDirectory: string;
  environmentOptions: string;
  externalProcessPath: string;
}

export type CviBuildEngine = 'cvi' | 'msvc';

export type CviImportLibraryArchitecture = 'auto' | 'x86' | 'x64' | 'arm64';
export type CviImportLibraryGenerator = 'auto' | 'msvc-lib' | 'llvm-lib' | 'llvm-dlltool' | 'gnu-dlltool';
export type CviDllImportLibraryFormat = 'auto' | 'gnu-a' | 'gnu-dll-a' | 'windows-lib' | 'gnu-both' | 'gnu-a-windows-lib' | 'both' | 'all' | 'none';

export interface CviImportLibraryConfiguration {
  generator: CviImportLibraryGenerator;
  generatorPath: string;
  architecture: CviImportLibraryArchitecture;
  outputDirectory: string;
  keepDefinitionFile: boolean;
}

export const DEFAULT_IMPORT_LIBRARY_CONFIGURATION: CviImportLibraryConfiguration = {
  generator: 'auto',
  generatorPath: '',
  architecture: 'auto',
  outputDirectory: 'lib',
  keepDefinitionFile: true
};

export interface CviExternalBuildSettings {
  engine: CviBuildEngine;
  vcvarsallPath: string;
  buildDirectory: string;
  additionalCompilerOptions: string;
  additionalLinkerOptions: string;
  additionalLibraries: string[];
  useCviExternalSupportFiles: boolean;
  debugInVsCode: boolean;
  dllImportLibraryFormat: CviDllImportLibraryFormat;
}

export interface CviProjectBuildSettings {
  preBuildActions: string[];
  customBuildActions: string[];
  postBuildActions: string[];
  dependencies: string[];
  run: CviRunSettings;
  externalBuild: CviExternalBuildSettings;
  importLibraries: CviImportLibraryConfiguration;
  nativeBuildActions: boolean;
}

interface CviProjectBuildSettingsStore {
  version: number;
  projects: Record<string, CviProjectBuildSettings>;
}

const EMPTY_RUN_SETTINGS: CviRunSettings = {
  arguments: '',
  workingDirectory: '',
  environmentOptions: '',
  externalProcessPath: ''
};

const EMPTY_EXTERNAL_BUILD_SETTINGS: CviExternalBuildSettings = {
  engine: 'cvi',
  vcvarsallPath: '',
  buildDirectory: '',
  additionalCompilerOptions: '',
  additionalLinkerOptions: '',
  additionalLibraries: [],
  useCviExternalSupportFiles: true,
  debugInVsCode: true,
  dllImportLibraryFormat: 'auto'
};

export class CviProjectSettingsService implements vscode.Disposable {
  private readonly activeShellChildren = new Set<ChildProcess>();
  private disposed = false;

  constructor(
    private readonly workspaces: CviWorkspaceService,
    private readonly parser: CviParser,
    private readonly output: vscode.OutputChannel
  ) {}

  dispose(): void {
    this.disposed = true;
    for (const child of this.activeShellChildren) {
      if (!child.killed) child.kill();
    }
    this.activeShellChildren.clear();
  }

  getConfigurationPath(): string | undefined {
    const root = this.getConfigurationRoot();
    return root ? path.join(root, '.vscode', 'labwindows-cvi-build.json') : undefined;
  }

  getSettings(projectRef: CviWorkspaceProjectRef, mode?: CviBuildMode): CviProjectBuildSettings {
    const effectiveMode = mode ?? this.resolveBuildMode(projectRef);
    const store = this.loadStore();
    const stored = store.projects[this.projectKey(projectRef.absolutePath)];
    const cwsRun = this.getCwsRunSettings(projectRef, effectiveMode);
    const nativeActions = this.parser.getProjectBuildActions(projectRef.absolutePath, effectiveMode);
    return normalizeSettings(stored, cwsRun, nativeActions.nativeSectionsPresent ? nativeActions : undefined, nativeActions.nativeSectionsPresent);
  }

  setSettings(projectRef: CviWorkspaceProjectRef, settings: CviProjectBuildSettings, mode?: CviBuildMode): void {
    const effectiveMode = mode ?? this.resolveBuildMode(projectRef);
    const store = this.loadStore();
    const normalized = normalizeSettings(settings);
    this.parser.setProjectBuildActions(projectRef.absolutePath, effectiveMode, normalized);
    normalized.nativeBuildActions = true;
    store.projects[this.projectKey(projectRef.absolutePath)] = normalized;
    this.saveStore(store);
    this.setCwsRunSettings(projectRef, normalized.run, effectiveMode);
    this.output.appendLine(`[CVI] Project build settings saved: ${projectRef.name} (${effectiveMode}).`);
  }

  getSettingsForConfiguration(projectRef: CviWorkspaceProjectRef, configurationName: string, fallbackMode?: CviBuildMode): CviProjectBuildSettings {
    const effectiveMode = fallbackMode ?? this.resolveBuildMode(projectRef);
    const base = this.getSettings(projectRef, effectiveMode);
    const customRun = this.getCwsRunSettingsForConfiguration(projectRef, configurationName);
    return { ...base, run: customRun ?? base.run, nativeBuildActions: true };
  }

  setCustomConfigurationMetadata(
    projectRef: CviWorkspaceProjectRef,
    configurationName: string,
    settings: CviProjectBuildSettings,
    writeRunSettings: boolean
  ): void {
    const store = this.loadStore();
    const key = this.projectKey(projectRef.absolutePath);
    const existing = normalizeSettings(store.projects[key]);
    existing.dependencies = deduplicate(settings.dependencies);
    store.projects[key] = existing;
    this.saveStore(store);
    if (writeRunSettings) {
      this.setCwsRunSettingsForConfiguration(projectRef, configurationName, settings.run);
    }
    this.output.appendLine(`[CVI] Custom configuration metadata saved: ${projectRef.name} (${configurationName}).`);
  }

  hasWorkspaceConfigurationSection(projectRef: CviWorkspaceProjectRef, configurationName: string): boolean {
    const workspace = this.workspaces.currentWorkspace;
    return Boolean(workspace?.path.toLowerCase().endsWith('.cws')
      && this.parser.hasWorkspaceBuildConfigurationSection(workspace.path, projectRef.index, configurationName));
  }

  getBuildOrder(projectRef: CviWorkspaceProjectRef): CviWorkspaceProjectRef[] {
    const workspace = this.workspaces.currentWorkspace;
    if (!workspace) {
      return [projectRef];
    }
    const byKey = new Map(workspace.projects.map((ref) => [this.projectKey(ref.absolutePath), ref]));
    const result: CviWorkspaceProjectRef[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (ref: CviWorkspaceProjectRef): void => {
      const key = this.projectKey(ref.absolutePath);
      if (visited.has(key)) {
        return;
      }
      if (visiting.has(key)) {
        throw new Error(`Circular CVI build dependency detected at ${ref.name}.`);
      }
      visiting.add(key);
      for (const dependencyKey of this.getSettings(ref).dependencies) {
        const dependency = byKey.get(dependencyKey);
        if (!dependency) {
          throw new Error(
            `Broken CVI project dependency: ${ref.name} depends on "${dependencyKey}", but that project is not present in the current workspace. ` +
            'Open Project Build Settings > Dependencies and repair the dependency list.'
          );
        }
        if (!dependency.exists) {
          throw new Error(
            `Broken CVI project dependency: ${ref.name} depends on ${dependency.name}, but its .prj file does not exist at ${dependency.absolutePath}.`
          );
        }
        visit(dependency);
      }
      visiting.delete(key);
      visited.add(key);
      result.push(ref);
    };

    visit(projectRef);
    return result;
  }

  hasNativeBuildActions(projectRef: CviWorkspaceProjectRef, mode?: CviBuildMode): boolean {
    return this.parser.getProjectBuildActions(projectRef.absolutePath, mode ?? this.resolveBuildMode(projectRef)).nativeSectionsPresent;
  }

  dependencyKey(projectRef: CviWorkspaceProjectRef): string {
    return this.projectKey(projectRef.absolutePath);
  }

  describeProjectRemoval(projectPath: string): string[] {
    const targetKey = this.projectKey(projectPath);
    const workspace = this.workspaces.currentWorkspace;
    if (!workspace) {
      return [];
    }
    const dependents: string[] = [];
    for (const ref of workspace.projects) {
      if (this.projectKey(ref.absolutePath) === targetKey) {
        continue;
      }
      if (this.getSettings(ref).dependencies.includes(targetKey)) {
        dependents.push(ref.name);
      }
    }
    return dependents;
  }

  migrateProjectPath(oldProjectPath: string, newProjectPath: string): () => void {
    const snapshot = this.captureStoreSnapshot();
    const store = this.loadStore();
    const oldKey = this.projectKey(oldProjectPath);
    const newKey = this.projectKey(newProjectPath);
    let changed = false;

    if (oldKey !== newKey && Object.prototype.hasOwnProperty.call(store.projects, oldKey)) {
      if (Object.prototype.hasOwnProperty.call(store.projects, newKey)) {
        throw new Error(`Cannot migrate CVI build settings because the destination key already exists: ${newKey}`);
      }
      store.projects[newKey] = store.projects[oldKey];
      delete store.projects[oldKey];
      changed = true;
    }

    if (oldKey !== newKey) {
      for (const settings of Object.values(store.projects)) {
        const migrated = deduplicate(settings.dependencies.map((dependency) => dependency === oldKey ? newKey : dependency));
        if (!sameStringArray(settings.dependencies, migrated)) {
          settings.dependencies = migrated;
          changed = true;
        }
      }
    }

    if (changed) {
      this.saveStore(store);
      this.output.appendLine(`[CVI] Migrated project dependency key: ${oldKey} -> ${newKey}`);
    }
    return () => this.restoreStoreSnapshot(snapshot);
  }

  removeProject(projectPath: string): () => void {
    const snapshot = this.captureStoreSnapshot();
    const store = this.loadStore();
    const targetKey = this.projectKey(projectPath);
    let changed = false;

    if (Object.prototype.hasOwnProperty.call(store.projects, targetKey)) {
      delete store.projects[targetKey];
      changed = true;
    }
    for (const settings of Object.values(store.projects)) {
      const filtered = settings.dependencies.filter((dependency) => dependency !== targetKey);
      if (!sameStringArray(settings.dependencies, filtered)) {
        settings.dependencies = filtered;
        changed = true;
      }
    }

    if (changed) {
      this.saveStore(store);
      this.output.appendLine(`[CVI] Removed project build settings and dependency references: ${targetKey}`);
    }
    return () => this.restoreStoreSnapshot(snapshot);
  }

  async runActions(actions: string[], label: string, cwd: string): Promise<boolean> {
    const commands = actions.map((entry) => entry.trim()).filter((entry) => entry && !entry.startsWith('#'));
    if (!commands.length) {
      return true;
    }
    this.output.appendLine(`[CVI] ${label}`);
    for (const command of commands) {
      this.output.appendLine(`[CVI] > ${command}`);
      const success = await this.runShellCommand(command, cwd);
      if (!success) {
        this.output.appendLine(`[CVI] ${label} failed.`);
        return false;
      }
    }
    return true;
  }

  parseArguments(value: string): string[] {
    const result: string[] = [];
    const pattern = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value)) !== null) {
      result.push(match[1] ?? match[2] ?? match[3]);
    }
    return result;
  }

  parseEnvironment(value: string): NodeJS.ProcessEnv {
    const result: NodeJS.ProcessEnv = { ...process.env };
    for (const entry of value.split(';')) {
      const trimmed = entry.trim();
      if (!trimmed) {
        continue;
      }
      const separator = trimmed.indexOf('=');
      if (separator <= 0) {
        continue;
      }
      const key = trimmed.slice(0, separator).trim();
      const val = trimmed.slice(separator + 1).trim();
      if (key) {
        result[key] = val;
      }
    }
    return result;
  }

  private getCwsRunSettingsForConfiguration(projectRef: CviWorkspaceProjectRef, configurationName: string): CviRunSettings | undefined {
    const workspace = this.workspaces.currentWorkspace;
    if (!workspace || path.extname(workspace.path).toLowerCase() !== '.cws') return undefined;
    return this.parser.getWorkspaceRunOptionsForConfiguration(workspace.path, projectRef.index, configurationName);
  }

  private setCwsRunSettingsForConfiguration(projectRef: CviWorkspaceProjectRef, configurationName: string, run: CviRunSettings): void {
    const workspace = this.workspaces.currentWorkspace;
    if (!workspace || path.extname(workspace.path).toLowerCase() !== '.cws') return;
    this.parser.setWorkspaceRunOptionsForConfiguration(workspace.path, projectRef.index, configurationName, run);
  }

  private getCwsRunSettings(projectRef: CviWorkspaceProjectRef, mode: CviBuildMode = this.buildMode): CviRunSettings | undefined {
    const workspace = this.workspaces.currentWorkspace;
    if (!workspace || path.extname(workspace.path).toLowerCase() !== '.cws') {
      return undefined;
    }
    return this.parser.getWorkspaceRunOptions(workspace.path, projectRef.index, mode);
  }

  private setCwsRunSettings(projectRef: CviWorkspaceProjectRef, run: CviRunSettings, mode: CviBuildMode = this.buildMode): void {
    const workspace = this.workspaces.currentWorkspace;
    if (!workspace || path.extname(workspace.path).toLowerCase() !== '.cws') {
      return;
    }
    this.parser.setWorkspaceRunOptions(workspace.path, projectRef.index, mode, run);
  }

  private get buildMode(): CviBuildMode {
    return vscode.workspace.getConfiguration('labwindowsCvi').get<CviBuildMode>('buildMode', 'debug');
  }

  private resolveBuildMode(projectRef: CviWorkspaceProjectRef): CviBuildMode {
    return this.workspaces.getProjectBuildMode(projectRef) ?? this.buildMode;
  }

  private getConfigurationRoot(): string | undefined {
    const workspace = this.workspaces.currentWorkspace;
    if (workspace) {
      return path.dirname(workspace.path);
    }
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private projectKey(projectPath: string): string {
    const root = this.getConfigurationRoot();
    if (!root) {
      return path.normalize(projectPath).replace(/\\/g, '/').toLowerCase();
    }
    return path.relative(root, projectPath).replace(/\\/g, '/').toLowerCase();
  }

  private loadStore(): CviProjectBuildSettingsStore {
    const filePath = this.getConfigurationPath();
    if (!filePath || !fs.existsSync(filePath)) {
      return { version: 1, projects: {} };
    }
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<CviProjectBuildSettingsStore>;
      return { version: 1, projects: raw.projects && typeof raw.projects === 'object' ? raw.projects : {} };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to read ${filePath}: ${message}`);
    }
  }

  private saveStore(store: CviProjectBuildSettingsStore): void {
    const filePath = this.getConfigurationPath();
    if (!filePath) {
      throw new Error('No CVI workspace directory is available to store build settings.');
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  }

  private captureStoreSnapshot(): { filePath?: string; existed: boolean; text?: string } {
    const filePath = this.getConfigurationPath();
    if (!filePath || !fs.existsSync(filePath)) {
      return { filePath, existed: false };
    }
    return { filePath, existed: true, text: fs.readFileSync(filePath, 'utf8') };
  }

  private restoreStoreSnapshot(snapshot: { filePath?: string; existed: boolean; text?: string }): void {
    if (!snapshot.filePath) {
      return;
    }
    if (!snapshot.existed) {
      if (fs.existsSync(snapshot.filePath)) {
        fs.unlinkSync(snapshot.filePath);
      }
      return;
    }
    fs.mkdirSync(path.dirname(snapshot.filePath), { recursive: true });
    fs.writeFileSync(snapshot.filePath, snapshot.text ?? '', 'utf8');
  }

  private async runShellCommand(command: string, cwd: string): Promise<boolean> {
    if (this.disposed) return false;
    return await new Promise<boolean>((resolve) => {
      const child = spawn(command, { cwd, shell: true, windowsHide: true });
      this.activeShellChildren.add(child);
      let settled = false;
      const finish = (result: boolean): void => {
        if (settled) return;
        settled = true;
        this.activeShellChildren.delete(child);
        resolve(result);
      };
      child.stdout?.on('data', (data: Buffer) => { if (!this.disposed) this.output.append(data.toString()); });
      child.stderr?.on('data', (data: Buffer) => { if (!this.disposed) this.output.append(data.toString()); });
      child.on('error', (error) => {
        if (!this.disposed) this.output.appendLine(`[CVI] Unable to run action: ${error.message}`);
        finish(false);
      });
      child.on('close', (code) => {
        if (!this.disposed) this.output.appendLine(`[CVI] Action exited with code ${String(code)}.`);
        finish(code === 0);
      });
    });
  }
}

function normalizeSettings(value?: Partial<CviProjectBuildSettings>, fallbackRun?: Partial<CviRunSettings>, nativeActions?: Partial<CviProjectBuildSettings>, nativeBuildActions = false): CviProjectBuildSettings {
  return {
    preBuildActions: normalizeActions(nativeActions?.preBuildActions ?? value?.preBuildActions),
    customBuildActions: normalizeActions(nativeActions?.customBuildActions ?? value?.customBuildActions),
    postBuildActions: normalizeActions(nativeActions?.postBuildActions ?? value?.postBuildActions),
    dependencies: Array.isArray(value?.dependencies) ? value.dependencies.map(String) : [],
    run: {
      arguments: String(fallbackRun?.arguments ?? value?.run?.arguments ?? EMPTY_RUN_SETTINGS.arguments),
      workingDirectory: String(fallbackRun?.workingDirectory ?? value?.run?.workingDirectory ?? EMPTY_RUN_SETTINGS.workingDirectory),
      environmentOptions: String(fallbackRun?.environmentOptions ?? value?.run?.environmentOptions ?? EMPTY_RUN_SETTINGS.environmentOptions),
      externalProcessPath: String(fallbackRun?.externalProcessPath ?? value?.run?.externalProcessPath ?? EMPTY_RUN_SETTINGS.externalProcessPath)
    },
    externalBuild: normalizeExternalBuildSettings(value?.externalBuild),
    importLibraries: normalizeImportLibraryConfiguration(value?.importLibraries),
    nativeBuildActions: nativeBuildActions || value?.nativeBuildActions === true
  };
}

function normalizeActions(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((entry) => entry.trim()).filter(Boolean) : [];
}

function deduplicate(values: string[]): string[] {
  return [...new Set(values)];
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeExternalBuildSettings(value?: Partial<CviExternalBuildSettings>): CviExternalBuildSettings {
  return {
    engine: value?.engine === 'msvc' ? 'msvc' : 'cvi',
    vcvarsallPath: String(value?.vcvarsallPath ?? EMPTY_EXTERNAL_BUILD_SETTINGS.vcvarsallPath),
    buildDirectory: String(value?.buildDirectory ?? EMPTY_EXTERNAL_BUILD_SETTINGS.buildDirectory),
    additionalCompilerOptions: String(value?.additionalCompilerOptions ?? EMPTY_EXTERNAL_BUILD_SETTINGS.additionalCompilerOptions),
    additionalLinkerOptions: String(value?.additionalLinkerOptions ?? EMPTY_EXTERNAL_BUILD_SETTINGS.additionalLinkerOptions),
    additionalLibraries: Array.isArray(value?.additionalLibraries) ? value!.additionalLibraries!.map(String).map((entry) => entry.trim()).filter(Boolean) : [],
    useCviExternalSupportFiles: value?.useCviExternalSupportFiles !== false,
    debugInVsCode: value?.debugInVsCode !== false,
    dllImportLibraryFormat: normalizeDllImportLibraryFormat(value?.dllImportLibraryFormat)
  };
}

function normalizeImportLibraryConfiguration(value?: Partial<CviImportLibraryConfiguration>): CviImportLibraryConfiguration {
  const generators = new Set<CviImportLibraryGenerator>(['auto','msvc-lib','llvm-lib','llvm-dlltool','gnu-dlltool']);
  const architectures = new Set<CviImportLibraryArchitecture>(['auto','x86','x64','arm64']);
  return {
    generator: generators.has(value?.generator as CviImportLibraryGenerator) ? value!.generator! : DEFAULT_IMPORT_LIBRARY_CONFIGURATION.generator,
    generatorPath: String(value?.generatorPath ?? DEFAULT_IMPORT_LIBRARY_CONFIGURATION.generatorPath),
    architecture: architectures.has(value?.architecture as CviImportLibraryArchitecture) ? value!.architecture! : DEFAULT_IMPORT_LIBRARY_CONFIGURATION.architecture,
    outputDirectory: String(value?.outputDirectory ?? DEFAULT_IMPORT_LIBRARY_CONFIGURATION.outputDirectory).trim() || DEFAULT_IMPORT_LIBRARY_CONFIGURATION.outputDirectory,
    keepDefinitionFile: value?.keepDefinitionFile !== false
  };
}

function normalizeDllImportLibraryFormat(value: unknown): CviDllImportLibraryFormat {
  const allowed = new Set<CviDllImportLibraryFormat>(['auto','gnu-a','gnu-dll-a','windows-lib','gnu-both','gnu-a-windows-lib','both','all','none']);
  return allowed.has(value as CviDllImportLibraryFormat) ? value as CviDllImportLibraryFormat : 'auto';
}
