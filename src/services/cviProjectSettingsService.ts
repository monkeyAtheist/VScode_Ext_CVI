import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
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

export interface CviProjectBuildSettings {
  preBuildActions: string[];
  customBuildActions: string[];
  postBuildActions: string[];
  dependencies: string[];
  run: CviRunSettings;
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

export class CviProjectSettingsService {
  constructor(
    private readonly workspaces: CviWorkspaceService,
    private readonly parser: CviParser,
    private readonly output: vscode.OutputChannel
  ) {}

  getConfigurationPath(): string | undefined {
    const root = this.getConfigurationRoot();
    return root ? path.join(root, '.vscode', 'labwindows-cvi-build.json') : undefined;
  }

  getSettings(projectRef: CviWorkspaceProjectRef, mode: CviBuildMode = this.buildMode): CviProjectBuildSettings {
    const store = this.loadStore();
    const stored = store.projects[this.projectKey(projectRef.absolutePath)];
    const cwsRun = this.getCwsRunSettings(projectRef, mode);
    const nativeActions = this.parser.getProjectBuildActions(projectRef.absolutePath, mode);
    return normalizeSettings(stored, cwsRun, nativeActions.nativeSectionsPresent ? nativeActions : undefined, nativeActions.nativeSectionsPresent);
  }

  setSettings(projectRef: CviWorkspaceProjectRef, settings: CviProjectBuildSettings, mode: CviBuildMode = this.buildMode): void {
    const store = this.loadStore();
    const normalized = normalizeSettings(settings);
    this.parser.setProjectBuildActions(projectRef.absolutePath, mode, normalized);
    normalized.nativeBuildActions = true;
    store.projects[this.projectKey(projectRef.absolutePath)] = normalized;
    this.saveStore(store);
    this.setCwsRunSettings(projectRef, normalized.run, mode);
    this.output.appendLine(`[CVI] Project build settings saved: ${projectRef.name}`);
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
        if (dependency?.exists) {
          visit(dependency);
        }
      }
      visiting.delete(key);
      visited.add(key);
      result.push(ref);
    };

    visit(projectRef);
    return result;
  }

  hasNativeBuildActions(projectRef: CviWorkspaceProjectRef): boolean {
    return this.parser.getProjectBuildActions(projectRef.absolutePath, this.buildMode).nativeSectionsPresent;
  }

  dependencyKey(projectRef: CviWorkspaceProjectRef): string {
    return this.projectKey(projectRef.absolutePath);
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

  private async runShellCommand(command: string, cwd: string): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      const child = spawn(command, { cwd, shell: true, windowsHide: true });
      child.stdout.on('data', (data: Buffer) => this.output.append(data.toString()));
      child.stderr.on('data', (data: Buffer) => this.output.append(data.toString()));
      child.on('error', (error) => {
        this.output.appendLine(`[CVI] Unable to run action: ${error.message}`);
        resolve(false);
      });
      child.on('close', (code) => {
        this.output.appendLine(`[CVI] Action exited with code ${String(code)}.`);
        resolve(code === 0);
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
    nativeBuildActions: nativeBuildActions || value?.nativeBuildActions === true
  };
}

function normalizeActions(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((entry) => entry.trim()).filter(Boolean) : [];
}
