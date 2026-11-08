import * as fs from 'fs';
import * as path from 'path';
import { ChildProcess, execFileSync, spawn } from 'child_process';
import * as vscode from 'vscode';
import { CviBuildMode, CviWorkspaceProjectRef } from '../model/types';
import { CviParser } from '../model/cviParser';
import { CviInstallation, CviWorkspace } from '../model/types';
import { CviInstallationService } from './cviInstallationService';
import { CviExternalBuildSettings, CviProjectSettingsService } from './cviProjectSettingsService';
import { CviWorkspaceService } from './cviWorkspaceService';
import { CviBreakpointSyncService } from './cviBreakpointSyncService';
import { normalizeRuntimePath, resolveCviReferencePath } from '../utils/pathUtils';


type CviBuildLogDetail = 'compact' | 'normal' | 'verbose';

interface ParsedCviDiagnostic {
  severity: 'error' | 'warning' | 'note';
  file?: string;
  line?: number;
  column?: number;
  code?: string;
  message: string;
  sourceLine?: string;
  hint?: string;
  toolLabel: string;
  rawLine: string;
}

interface CviToolRunResult {
  success: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  logText: string;
  logFile: string;
  durationMs: number;
  diagnostics: ParsedCviDiagnostic[];
}

interface CviBuildReport {
  label: string;
  startedAt: Date;
  startedMs: number;
  toolRuns: number;
  errors: ParsedCviDiagnostic[];
  warnings: ParsedCviDiagnostic[];
  notes: ParsedCviDiagnostic[];
  failedAt?: string;
  projectTotal: number;
  projectBuilt: number;
}

export class CviBuildService implements vscode.Disposable {
  constructor(
    private readonly parser: CviParser,
    private readonly workspaces: CviWorkspaceService,
    private readonly installations: CviInstallationService,
    private readonly projectSettings: CviProjectSettingsService,
    private readonly breakpoints: CviBreakpointSyncService,
    private readonly output: vscode.OutputChannel,
    private readonly traceOutput: vscode.OutputChannel,
    private readonly diagnostics: vscode.DiagnosticCollection
  ) {}

  private currentReport: CviBuildReport | undefined;
  private readonly activeCompilerChildren = new Set<ChildProcess>();
  private readonly activeLogTimers = new Set<NodeJS.Timeout>();
  private disposed = false;

  dispose(): void {
    this.disposed = true;
    for (const timer of this.activeLogTimers) clearInterval(timer);
    this.activeLogTimers.clear();
    for (const child of this.activeCompilerChildren) {
      if (!child.killed) child.kill();
    }
    this.activeCompilerChildren.clear();
    this.currentReport = undefined;
  }

  get buildMode(): CviBuildMode {
    const ref = this.workspaces.activeProjectRef;
    return ref ? this.resolveBuildMode(ref) : this.configuredBuildMode;
  }

  getBuildEngine(projectRef?: CviWorkspaceProjectRef): 'cvi' | 'msvc' {
    const ref = projectRef ?? this.workspaces.activeProjectRef;
    if (!ref?.exists) return 'cvi';
    let mode = this.resolveBuildMode(ref);
    const customConfiguration = this.resolveCustomBuildConfiguration(ref);
    if (customConfiguration) mode = this.modeForConfiguration(ref.absolutePath, customConfiguration, mode);
    return this.projectSettings.getSettings(ref, mode).externalBuild?.engine === 'msvc' ? 'msvc' : 'cvi';
  }

  private get configuredBuildMode(): CviBuildMode {
    return vscode.workspace.getConfiguration('labwindowsCvi').get<CviBuildMode>('buildMode', 'debug');
  }

  private resolveBuildMode(projectRef: CviWorkspaceProjectRef): CviBuildMode {
    return this.workspaces.getProjectBuildMode(projectRef) ?? this.configuredBuildMode;
  }

  private resolveCustomBuildConfiguration(projectRef: CviWorkspaceProjectRef): string {
    const configured = this.customBuildConfiguration;
    if (configured) return configured;
    const workspaceService = this.workspaces as CviWorkspaceService & Partial<Pick<CviWorkspaceService, 'getProjectBuildConfiguration'>>;
    const nativeName = workspaceService.getProjectBuildConfiguration?.(projectRef)?.trim() || projectRef.buildConfiguration?.trim() || '';
    return nativeName && !this.workspaces.getProjectBuildMode(projectRef) ? nativeName : '';
  }

  private modeForConfiguration(projectPath: string, configurationName: string, fallback: CviBuildMode): CviBuildMode {
    const parser = this.parser as CviParser & Partial<Pick<CviParser, 'getNativeBuildConfiguration'>>;
    const descriptor = parser.getNativeBuildConfiguration?.(projectPath, configurationName);
    if (!descriptor) return fallback;
    if (descriptor.is64Bit) return descriptor.isRelease ? 'release64' : 'debug64';
    return descriptor.isRelease ? 'release' : 'debug';
  }

  async chooseBuildAction(projectRef?: CviWorkspaceProjectRef): Promise<void> {
    const selected = await vscode.window.showQuickPick([
      { label: '$(tools) Build', value: 'build', description: 'Build the target and configured dependencies' },
      { label: '$(sync) Rebuild', value: 'rebuild', description: 'Force recompilation with compile.exe -rebuild' },
      { label: '$(trash) Clean generated target', value: 'clean', description: 'Delete generated target files without touching source files' }
    ], { title: 'LabWindows/CVI build action' });
    if (!selected) {
      return;
    }
    if (selected.value === 'clean') {
      await this.clean(projectRef);
    } else {
      await this.build(selected.value === 'rebuild', projectRef);
    }
  }

  async chooseRunAction(projectRef?: CviWorkspaceProjectRef): Promise<void> {
    const selected = await vscode.window.showQuickPick([
      { label: '$(play) Build and run', value: 'buildRun', description: 'Build with the selected project build engine and run the target' },
      { label: '$(run) Run', value: 'runOnly', description: 'Run the existing EXE, or the configured Program Name for a DLL target, without building' },
      { label: '$(debug-alt) Debug', value: 'debugExisting', description: 'Launch the selected debugger using the existing target without forcing a build first' },
      { label: '$(debug-alt) Build and debug', value: 'debug', description: 'Build with CVI, synchronize breakpoints and run the native CVI debugger' },
      { label: '$(debug) External MSVC debug in VS Code', value: 'externalDebug', description: 'Build with MSVC and launch cppvsdbg using generated PDB symbols' }
    ], { title: 'LabWindows/CVI run action' });
    if (!selected) {
      return;
    }
    if (selected.value === 'runOnly') {
      await this.runWithoutBuild(projectRef);
    } else if (selected.value === 'debugExisting') {
      await vscode.commands.executeCommand('labwindowsCvi.debugWithoutBuild');
    } else if (selected.value === 'debug') {
      await vscode.commands.executeCommand('labwindowsCvi.nativeRun');
    } else if (selected.value === 'externalDebug') {
      await this.debugWithExternalCompiler(projectRef);
    } else {
      await this.buildAndRun(projectRef);
    }
  }

  async selectBuildMode(): Promise<void> {
    const ref = this.workspaces.activeProjectRef;
    const standard = [
      { label: 'Debug x86 (32b)', value: 'debug', nativeName: 'Debug', description: 'compile.exe -debug' },
      { label: 'Release x86 (32b)', value: 'release', nativeName: 'Release', description: 'compile.exe -release' },
      { label: 'Debug x64 (64b)', value: 'debug64', nativeName: 'Debug64', description: 'compile.exe -debug64' },
      { label: 'Release x64 (64b)', value: 'release64', nativeName: 'Release64', description: 'compile.exe -release64' }
    ] as const;
    const custom = ref?.exists ? this.parser.getNativeBuildConfigurations(ref.absolutePath)
      .filter((entry) => entry.isCustom)
      .map((entry) => ({
        label: `${entry.name} (${entry.is64Bit ? 'x64' : 'x86'} · ${entry.isRelease ? 'Release' : 'Debug'})`,
        value: entry.name,
        nativeName: entry.name,
        description: `compile.exe -config=${entry.name}`,
        custom: true as const,
        descriptor: entry
      })) : [];
    const items: Array<{ label: string; value: string; nativeName: string; description: string; custom?: boolean; descriptor?: { is64Bit: boolean; isRelease: boolean } }> = [...standard, ...custom];
    const selected = await vscode.window.showQuickPick(items, { title: 'Select the LabWindows/CVI build configuration' });
    if (!selected) return;

    const config = vscode.workspace.getConfiguration('labwindowsCvi');
    if (selected.custom && ref) {
      this.workspaces.setProjectBuildConfiguration(ref, selected.nativeName);
      const fallbackMode: CviBuildMode = selected.descriptor?.is64Bit
        ? (selected.descriptor.isRelease ? 'release64' : 'debug64')
        : (selected.descriptor?.isRelease ? 'release' : 'debug');
      await config.update('buildMode', fallbackMode, vscode.ConfigurationTarget.Workspace);
      await config.update('customBuildConfiguration', selected.nativeName, vscode.ConfigurationTarget.Workspace);
    } else {
      const mode = selected.value as CviBuildMode;
      if (ref) this.workspaces.setProjectBuildMode(ref, mode);
      await config.update('buildMode', mode, vscode.ConfigurationTarget.Workspace);
      await config.update('customBuildConfiguration', '', vscode.ConfigurationTarget.Workspace);
    }
    vscode.window.showInformationMessage(`LabWindows/CVI build configuration: ${selected.label}${ref && this.workspaces.currentWorkspace?.path.toLowerCase().endsWith('.cws') ? ' (synchronized with the native CVI workspace)' : ''}.`);
  }

  async ensureDebugBuildMode(projectRef?: CviWorkspaceProjectRef): Promise<boolean> {
    const ref = projectRef ?? this.workspaces.activeProjectRef;
    if (!ref?.exists) {
      vscode.window.showErrorMessage('No existing CVI project is available for debugging.');
      return false;
    }
    let mode = this.resolveBuildMode(ref);
    const customConfiguration = this.resolveCustomBuildConfiguration(ref);
    if (customConfiguration) {
      const descriptor = this.parser.getNativeBuildConfiguration(ref.absolutePath, customConfiguration);
      if (descriptor) {
        mode = descriptor.is64Bit ? (descriptor.isRelease ? 'release64' : 'debug64') : (descriptor.isRelease ? 'release' : 'debug');
        if (!descriptor.isRelease) return true;
      }
    }
    if (mode === 'debug' || mode === 'debug64') {
      return true;
    }
    const debugMode: CviBuildMode = mode === 'release64' ? 'debug64' : 'debug';
    const answer = await vscode.window.showWarningMessage(
      `The active build mode is ${mode}. Native CVI debugging requires a debug configuration. Switch ${ref.name} to ${debugMode}?`,
      'Switch to debug',
      'Cancel'
    );
    if (answer !== 'Switch to debug') {
      return false;
    }
    this.workspaces.setProjectBuildMode(ref, debugMode);
    const config = vscode.workspace.getConfiguration('labwindowsCvi');
    await config.update('buildMode', debugMode, vscode.ConfigurationTarget.Workspace);
    if (customConfiguration) await config.update('customBuildConfiguration', '', vscode.ConfigurationTarget.Workspace);
    return true;
  }

  async build(rebuild = false, projectRef?: CviWorkspaceProjectRef, engineOverride?: 'cvi' | 'msvc'): Promise<boolean> {
    const ref = projectRef ?? this.workspaces.activeProjectRef;
    if (!ref?.exists) {
      vscode.window.showErrorMessage('No existing active CVI project is available for build.');
      return false;
    }
    const installation = await this.requireInstallation();
    if (!installation) {
      return false;
    }

    const rootMode = this.resolveBuildMode(ref);
    const report = this.beginOutput(`${rebuild ? 'Rebuild' : 'Build'} ${ref.name}`, rootMode);
    let success = false;
    let failedAt = '';
    try {
      const order = this.projectSettings.getBuildOrder(ref);
      report.projectTotal = order.length;

      this.appendSection('BUILD ORDER');
      for (const item of order) {
        this.output.appendLine(`  ${item.name}`);
      }
      this.output.appendLine('');
      this.traceOutput.appendLine(`[CVI] Build order: ${order.map((item) => item.name).join(' -> ')}`);
      this.traceOutput.appendLine('');

      for (const item of order) {
        const cwd = path.dirname(item.absolutePath);
        let itemMode = this.resolveBuildMode(item);
        const project = this.workspaces.getProject(item);
        const compilerParser = this.parser as CviParser & Partial<Pick<CviParser, 'getNativeCompilerSettings' | 'getProjectCompilerSettings' | 'inspectNativeCompilerConfiguration'>>;
        const isRequestedProject = path.resolve(item.absolutePath).toLowerCase() === path.resolve(ref.absolutePath).toLowerCase();
        const customConfiguration = isRequestedProject ? this.resolveCustomBuildConfiguration(item) : '';
        if (customConfiguration) itemMode = this.modeForConfiguration(item.absolutePath, customConfiguration, itemMode);
        const settings = this.projectSettings.getSettings(item, itemMode);
        const targetPath = customConfiguration && typeof (this.parser as any).getTargetPathForConfiguration === 'function'
          ? (this.parser as any).getTargetPathForConfiguration(item.absolutePath, customConfiguration, itemMode)
          : this.parser.getTargetPath(item.absolutePath, itemMode);
        const compilerSettings = customConfiguration && typeof (this.parser as any).getNativeCompilerSettingsForConfiguration === 'function'
          ? (this.parser as any).getNativeCompilerSettingsForConfiguration(item.absolutePath, customConfiguration)
          : (typeof compilerParser.getNativeCompilerSettings === 'function' ? compilerParser.getNativeCompilerSettings(item.absolutePath, itemMode) : undefined);
        const projectCompilerSettings = typeof compilerParser.getProjectCompilerSettings === 'function' ? compilerParser.getProjectCompilerSettings(item.absolutePath) : undefined;
        const compilerIssues = customConfiguration && typeof (this.parser as any).inspectNativeCompilerConfigurationForConfiguration === 'function'
          ? (this.parser as any).inspectNativeCompilerConfigurationForConfiguration(item.absolutePath, customConfiguration, itemMode)
          : (typeof compilerParser.inspectNativeCompilerConfiguration === 'function' ? compilerParser.inspectNativeCompilerConfiguration(item.absolutePath, itemMode) : []);
        const nativeBuildActions = this.projectSettings.hasNativeBuildActions(item, itemMode);
        const effectiveBuildEngine = engineOverride ?? settings.externalBuild?.engine ?? 'cvi';
        // compile.exe remains the owner of build steps whenever -config=<name> is used.
        // Even when CVI PM can safely inspect the serialized compiler fields, it must not
        // duplicate actions that belong to the named native CVI configuration.
        const compilerOwnsBuildActions = effectiveBuildEngine === 'cvi' && (nativeBuildActions || customConfiguration.length > 0);

        this.appendSection('PROJECT / TOOLCHAIN');
        this.output.appendLine(`  Project   : ${item.name}`);
        this.output.appendLine(`  Project   : ${item.absolutePath}`);
        this.output.appendLine(`  Mode      : ${itemMode}`);
        this.output.appendLine(`  Target    : ${targetPath ? normalizeRuntimePath(targetPath) : '<not resolved from .prj>'}`);
        this.output.appendLine(`  Type      : ${project?.targetType ?? '<unknown>'}`);
        this.output.appendLine(`  Compiler  : ${effectiveBuildEngine === 'msvc' ? 'Microsoft Visual C++ (external)' : (installation.compileExe ?? '<compile.exe missing>')}`);
        this.output.appendLine(`  Config    : ${customConfiguration ? `named CVI configuration "${customConfiguration}"` : itemMode}`);
        this.output.appendLine(`  Sources   : ${project ? countCompiledSources(project.files) : 0}`);
        if (compilerSettings) {
          this.output.appendLine(`  Defines   : ${compilerSettings.compilerDefines || '<none>'}`);
          this.output.appendLine(`  Includes  : ${projectCompilerSettings?.includePaths.length ?? 0}`);
          this.output.appendLine(`  Warnings  : ${compilerSettings.uninitializedLocalsCompileWarning}${compilerSettings.supportsWarningProfile && compilerSettings.selectedWarningLevel ? ` / ${compilerSettings.selectedWarningLevel}` : ''}`);
          this.output.appendLine(`  Optimize  : ${compilerSettings.supportsOptimizationLevel ? (compilerSettings.optimizationLevel || '<native default>') : '<not serialized by this project>'}`);
        }
        this.output.appendLine(`  Actions   : ${compilerOwnsBuildActions ? (customConfiguration ? 'owned by named CVI configuration / compile.exe' : 'native CVI .prj actions executed by compile.exe') : 'extension-managed pre/custom/post actions'}`);
        if (!isRequestedProject && this.resolveCustomBuildConfiguration(ref)) {
          this.output.appendLine('  Note      : named -config override applies only to the requested project; dependency projects keep their own native CVI mode.');
        }
        this.output.appendLine('');
        if (compilerIssues.length > 0) {
          this.output.appendLine('  Compiler configuration warnings:');
          for (const issue of compilerIssues) {
            this.output.appendLine(`    [!] ${issue.field}: ${issue.message}`);
            this.recordSyntheticWarning(`Compiler options — ${item.name}`, issue.message, item.absolutePath);
          }
          this.output.appendLine('');
        }

        if (compilerOwnsBuildActions) {
          if (customConfiguration) {
            this.output.appendLine(`[CVI] Named CVI configuration "${customConfiguration}" selected for ${item.name}; compile.exe owns that configuration's build steps. Extension-side fallback actions are intentionally skipped to prevent duplicate execution.`);
          } else {
            this.output.appendLine(`[CVI] Native CVI build steps detected for ${item.name}; compile.exe will execute the .prj pre-build, custom and post-build actions.`);
          }
          this.output.appendLine('');
        } else {
          if (!await this.projectSettings.runActions(settings.preBuildActions, `Pre-build actions — ${item.name}`, cwd)) {
            failedAt = `Pre-build actions — ${item.name}`;
            this.recordSyntheticFailure(failedAt, 'A pre-build action returned a failure status. Check the action output above and the configured command in CVI Project Build Settings.');
            return false;
          }
          if (!await this.projectSettings.runActions(settings.customBuildActions, `Custom build actions — ${item.name}`, cwd)) {
            failedAt = `Custom build actions — ${item.name}`;
            this.recordSyntheticFailure(failedAt, 'A custom build action returned a failure status. Check the action output above and the configured command in CVI Project Build Settings.');
            return false;
          }
        }

        let result: CviToolRunResult;
        if (effectiveBuildEngine === 'msvc') {
          result = await this.runExternalMsvcBuild(item, project, itemMode, customConfiguration, targetPath, compilerSettings, projectCompilerSettings, settings.externalBuild ?? defaultExternalBuildSettings(), installation, rebuild);
        } else {
          if (!installation.compileExe) {
            failedAt = `${rebuild ? 'Rebuild' : 'Build'} ${item.name}`;
            this.recordSyntheticFailure(failedAt, 'compile.exe is required for the native CVI build engine. Select a valid LabWindows/CVI installation or switch this project to External MSVC Build.');
            return false;
          }
          const args: string[] = [item.absolutePath, ...this.commonCompilerArguments(rebuild, itemMode, customConfiguration)];
          result = await this.runCviCompile(installation.compileExe, args, cwd, `${rebuild ? 'Rebuild' : 'Build'} ${item.name}`);
        }
        if (!result.success) {
          failedAt = this.currentReport?.failedAt ?? `${rebuild ? 'Rebuild' : 'Build'} ${item.name}`;
          return false;
        }
        report.projectBuilt += 1;

        if (!compilerOwnsBuildActions && !await this.projectSettings.runActions(settings.postBuildActions, `Post-build actions — ${item.name}`, cwd)) {
          failedAt = `Post-build actions — ${item.name}`;
          this.recordSyntheticFailure(failedAt, 'A post-build action returned a failure status. Check the action output above and the configured command in CVI Project Build Settings.');
          return false;
        }
      }

      success = true;
      vscode.window.showInformationMessage(`${rebuild ? 'Rebuild' : 'Build'} completed successfully.`);
      return true;
    } finally {
      this.finishOutput(report, success, failedAt);
    }
  }

  async buildNative(rebuild = false, projectRef?: CviWorkspaceProjectRef): Promise<boolean> {
    return await this.build(rebuild, projectRef, 'cvi');
  }

  async clean(projectRef?: CviWorkspaceProjectRef): Promise<void> {
    const ref = projectRef ?? this.workspaces.activeProjectRef;
    if (!ref?.exists) {
      vscode.window.showErrorMessage('No existing active CVI project is available to clean.');
      return;
    }
    let mode = this.resolveBuildMode(ref);
    const customConfiguration = this.resolveCustomBuildConfiguration(ref);
    if (customConfiguration) mode = this.modeForConfiguration(ref.absolutePath, customConfiguration, mode);
    const report = this.beginOutput(`Clean ${ref.name}`, mode);
    let success = true;
    try {
      const project = this.workspaces.getProject(ref);
      const buildSettings = this.projectSettings.getSettings(ref, mode);
      const target = customConfiguration
        ? this.parser.getTargetPathForConfiguration(ref.absolutePath, customConfiguration, mode)
        : this.parser.getTargetPath(ref.absolutePath, mode);
      const candidates = new Set<string>();
      if (target) {
        candidates.add(target);
        // CVI debug databases belong to the debug configuration. Do not remove them
        // while cleaning Release/Release64, especially when several configurations
        // intentionally share the same target base name.
        if (mode === 'debug' || mode === 'debug64') {
          candidates.add(replaceExtension(target, '.cdb'));
          candidates.add(replaceExtension(target, '.pdb'));
        }
        // Do not guess a DLL import-library path here. CVI can use a custom import
        // library base name/copy destination, and deleting <target>.lib blindly can
        // remove a user-managed library that is not the artifact of this mode.
      }

      this.appendSection('CLEAN GENERATED TARGET');
      this.output.appendLine(`  Project   : ${ref.name}`);
      this.output.appendLine(`  Mode      : ${mode}`);
      this.output.appendLine(`  Target    : ${target ? normalizeRuntimePath(target) : '<not resolved from .prj>'}`);
      this.output.appendLine(`  Type      : ${project?.targetType ?? '<unknown>'}`);
      if (project?.targetType === 'Dynamic Link Library') {
        this.output.appendLine('  Import lib: preserved (CVI may use a custom base name or copy destination)');
      }
      this.output.appendLine('');

      let removed = 0;
      for (const candidate of candidates) {
        if (!fs.existsSync(candidate)) {
          continue;
        }
        try {
          fs.rmSync(candidate, { force: true });
          this.output.appendLine(`  [OK] Deleted: ${candidate}`);
          removed += 1;
        } catch (error) {
          success = false;
          const message = error instanceof Error ? error.message : String(error);
          this.output.appendLine(`  [X] Unable to delete ${candidate}: ${message}`);
          this.recordSyntheticFailure(`Clean ${ref.name}`, `Unable to delete ${candidate}: ${message}`);
        }
      }
      if (buildSettings.externalBuild?.engine === 'msvc') {
        const cwd = path.dirname(ref.absolutePath);
        const configName = customConfiguration || mode;
        const externalDir = buildSettings.externalBuild?.buildDirectory?.trim()
          ? this.resolveRuntimeReference(buildSettings.externalBuild.buildDirectory, cwd)
          : path.join(path.dirname(this.projectSettings.getConfigurationPath() ?? path.join(cwd, '.vscode', 'x')), 'cvi-external-build', path.basename(ref.absolutePath, path.extname(ref.absolutePath)), sanitizeFilePart(configName));
        if (externalDir && fs.existsSync(externalDir)) {
          try { fs.rmSync(externalDir, { recursive: true, force: true }); this.output.appendLine(`  [OK] Deleted external build directory: ${externalDir}`); removed += 1; }
          catch (error) { success = false; this.recordSyntheticFailure(`Clean ${ref.name}`, `Unable to delete external build directory ${externalDir}: ${error instanceof Error ? error.message : String(error)}`); }
        }
      }
      if (removed === 0) {
        this.output.appendLine('  No generated target file was found. Source files and referenced libraries were not modified.');
      }
      vscode.window.showInformationMessage(`Clean completed for ${ref.name}: ${removed} generated file(s) removed.`);
    } finally {
      this.finishOutput(report, success, success ? '' : `Clean ${ref.name}`);
    }
  }

  async compileFile(filePath: string, projectRef?: CviWorkspaceProjectRef): Promise<boolean> {
    const ref = projectRef ?? this.workspaces.activeProjectRef;
    if (!ref?.exists) {
      vscode.window.showErrorMessage('No existing CVI project is available to provide compiler options.');
      return false;
    }
    if (path.extname(filePath).toLowerCase() !== '.c') {
      vscode.window.showErrorMessage('Compile File is available only for C source files.');
      return false;
    }
    if (!fs.existsSync(filePath)) {
      vscode.window.showErrorMessage(`Source file not found: ${filePath}`);
      return false;
    }
    const installation = await this.requireCompiler();
    if (!installation?.compileExe) {
      return false;
    }

    const mode = this.resolveBuildMode(ref);
    const report = this.beginOutput(`Compile ${path.basename(filePath)}`, mode);
    let success = false;
    try {
      this.appendSection('SOURCE / TOOLCHAIN');
      this.output.appendLine(`  Source    : ${filePath}`);
      this.output.appendLine(`  Project   : ${ref.absolutePath}`);
      this.output.appendLine(`  Compiler  : ${installation.compileExe}`);
      const compilerParser = this.parser as CviParser & Partial<Pick<CviParser, 'getNativeCompilerSettings' | 'getProjectCompilerSettings' | 'inspectNativeCompilerConfiguration'>>;
      const compilerSettings = typeof compilerParser.getNativeCompilerSettings === 'function' ? compilerParser.getNativeCompilerSettings(ref.absolutePath, mode) : undefined;
      const projectCompilerSettings = typeof compilerParser.getProjectCompilerSettings === 'function' ? compilerParser.getProjectCompilerSettings(ref.absolutePath) : undefined;
      if (compilerSettings) {
        this.output.appendLine(`  Defines   : ${compilerSettings.compilerDefines || '<none>'}`);
        this.output.appendLine(`  Includes  : ${projectCompilerSettings?.includePaths.length ?? 0}`);
      }
      const compilerIssues = typeof compilerParser.inspectNativeCompilerConfiguration === 'function' ? compilerParser.inspectNativeCompilerConfiguration(ref.absolutePath, mode) : [];
      for (const issue of compilerIssues) {
        this.output.appendLine(`  [!] ${issue.field}: ${issue.message}`);
        this.recordSyntheticWarning(`Compiler options — ${ref.name}`, issue.message, ref.absolutePath);
      }
      this.output.appendLine('');

      if (this.customBuildConfiguration) {
        this.output.appendLine(`  Note      : named CVI configuration "${this.customBuildConfiguration}" is not applied to Compile File; the source is compiled with the project's ${mode} build options.`);
        this.output.appendLine('');
      }
      const args = [filePath, ref.absolutePath, ...this.commonCompilerArguments(false, mode, '')];
      const result = await this.runCviCompile(installation.compileExe, args, path.dirname(ref.absolutePath), `Compile ${path.basename(filePath)}`);
      success = result.success;
      if (success) {
        vscode.window.showInformationMessage(`${path.basename(filePath)} compiled successfully.`);
      }
      return success;
    } finally {
      this.finishOutput(report, success, success ? '' : `Compile ${path.basename(filePath)}`);
    }
  }

  async debugWithExternalCompiler(projectRef?: CviWorkspaceProjectRef, buildFirst = true): Promise<void> {
    const ref = projectRef ?? this.workspaces.activeProjectRef;
    if (!ref?.exists) {
      vscode.window.showErrorMessage('No existing CVI project is available for external debugging.');
      return;
    }
    let mode = this.resolveBuildMode(ref);
    const customConfiguration = this.resolveCustomBuildConfiguration(ref);
    if (customConfiguration) mode = this.modeForConfiguration(ref.absolutePath, customConfiguration, mode);
    const settings = customConfiguration
      ? this.projectSettings.getSettingsForConfiguration(ref, customConfiguration, mode)
      : this.projectSettings.getSettings(ref, mode);
    if (settings.externalBuild?.engine !== 'msvc') {
      vscode.window.showWarningMessage('External VS Code debugging requires the project Build Engine to be set to Microsoft Visual C++ in CVI Project Settings > External Compiler.');
      return;
    }
    if (!(mode === 'debug' || mode === 'debug64')) {
      vscode.window.showWarningMessage('External VS Code debugging is intended for Debug/Debug64 configurations. Select a debug configuration first.');
      return;
    }
    if (settings.externalBuild?.debugInVsCode === false) {
      vscode.window.showWarningMessage('VS Code external debugging is disabled in this project External Compiler settings.');
      return;
    }
    if (buildFirst) {
      const built = await this.build(false, ref);
      if (!built) return;
    }
    await this.launchExternalMsvcDebugger(ref, mode, settings, buildFirst);
  }

  async debugExistingExternalTarget(projectRef?: CviWorkspaceProjectRef): Promise<void> {
    await this.debugWithExternalCompiler(projectRef, false);
  }

  private async launchExternalMsvcDebugger(
    ref: CviWorkspaceProjectRef,
    mode: CviBuildMode,
    settings: ReturnType<CviProjectSettingsService['getSettings']>,
    builtImmediatelyBeforeLaunch: boolean
  ): Promise<void> {
    const customConfiguration = this.resolveCustomBuildConfiguration(ref);
    const target = customConfiguration
      ? this.parser.getTargetPathForConfiguration(ref.absolutePath, customConfiguration, mode)
      : this.parser.getTargetPath(ref.absolutePath, mode);
    const project = this.workspaces.getProject(ref);
    const run = settings.run;
    if (project?.targetType === 'Static Library') {
      vscode.window.showWarningMessage('A static library cannot be launched directly in the debugger. Debug an executable or DLL host project that links this library.');
      return;
    }
    if (!target || !fs.existsSync(target)) {
      vscode.window.showErrorMessage('Unable to start the VS Code debugger because the existing external build target does not exist. Build the project once, then use Debug Existing Target.');
      return;
    }
    const pdb = replaceExtension(target, '.pdb');
    if (!fs.existsSync(pdb)) {
      vscode.window.showErrorMessage(`Unable to start external debugging without a build because the PDB file is missing: ${pdb}. Build the Debug target once to generate symbols.`);
      return;
    }
    if (!builtImmediatelyBeforeLaunch) {
      try {
        const targetTime = fs.statSync(target).mtimeMs;
        const pdbTime = fs.statSync(pdb).mtimeMs;
        if (targetTime - pdbTime > 2000) {
          this.output.appendLine(`[CVI] Debug Existing Target warning: ${path.basename(pdb)} is older than ${path.basename(target)}. VS Code will launch without rebuilding; symbols may be stale.`);
          vscode.window.showWarningMessage('The existing PDB is older than the target binary. Debug will start without rebuilding, but source/symbol mapping may be stale.');
        }
      } catch { /* timestamp diagnostics are best effort */ }
    }
    let program = target;
    if (project?.targetType === 'Dynamic Link Library') {
      program = this.resolveRuntimeReference(run.externalProcessPath, path.dirname(ref.absolutePath));
    }
    if (!program || !fs.existsSync(program)) {
      vscode.window.showErrorMessage('Unable to start the VS Code debugger because the existing target/host executable does not exist.');
      return;
    }
    const cwd = this.resolveRuntimeReference(run.workingDirectory, path.dirname(ref.absolutePath)) || path.dirname(program);
    if (!fs.existsSync(cwd)) {
      vscode.window.showErrorMessage(`Unable to start the VS Code debugger because the working directory does not exist: ${cwd}`);
      return;
    }
    const args = run.arguments.trim() ? this.projectSettings.parseArguments(run.arguments) : [];
    const started = await vscode.debug.startDebugging(undefined, {
      name: `CVI External MSVC — ${ref.name}`,
      type: 'cppvsdbg',
      request: 'launch',
      program,
      args,
      cwd,
      stopAtEntry: false
    });
    if (!started) {
      vscode.window.showErrorMessage('VS Code could not start cppvsdbg. Install/enable the Microsoft C/C++ extension and verify the external MSVC Debug build produced PDB symbols.');
    }
  }

  async run(projectRef?: CviWorkspaceProjectRef): Promise<void> {
    await this.runWithoutBuild(projectRef);
  }

  async buildAndRun(projectRef?: CviWorkspaceProjectRef): Promise<void> {
    const ref = projectRef ?? this.workspaces.activeProjectRef;
    if (!ref?.exists) {
      vscode.window.showErrorMessage('No existing CVI project is available to build and run.');
      return;
    }
    const success = await this.build(false, ref);
    if (!success) {
      return;
    }
    await this.runWithoutBuild(ref);
  }

  async runWithoutBuild(projectRef?: CviWorkspaceProjectRef): Promise<void> {
    const ref = projectRef ?? this.workspaces.activeProjectRef;
    if (!ref?.exists) {
      vscode.window.showErrorMessage('No existing CVI project is available to run.');
      return;
    }
    const project = this.workspaces.getProject(ref);
    const targetType = project?.targetType ?? 'Unknown';
    let mode = this.resolveBuildMode(ref);
    const customConfiguration = this.resolveCustomBuildConfiguration(ref);
    if (customConfiguration) mode = this.modeForConfiguration(ref.absolutePath, customConfiguration, mode);
    const run = customConfiguration
      ? this.projectSettings.getSettingsForConfiguration(ref, customConfiguration, mode).run
      : this.projectSettings.getSettings(ref, mode).run;
    const targetPath = customConfiguration
      ? this.parser.getTargetPathForConfiguration(ref.absolutePath, customConfiguration, mode)
      : this.parser.getTargetPath(ref.absolutePath, mode);

    if (targetType === 'Static Library') {
      vscode.window.showErrorMessage('A static library cannot be run. Select an executable project, or use a DLL project with a Program Name host executable.');
      return;
    }

    const useExternalHost = targetType === 'Dynamic Link Library';
    let rawExecutablePath: string | undefined;
    if (useExternalHost) {
      rawExecutablePath = run.externalProcessPath.trim();
      if (!rawExecutablePath) {
        const action = await vscode.window.showErrorMessage(
          'This project builds a DLL, so the DLL cannot be launched directly. Configure Program Name with the executable that loads the DLL, as in LabWindows/CVI.',
          'Open Run Settings'
        );
        if (action === 'Open Run Settings') {
          // Preserve the project context when Run was invoked from a non-active project.
          await vscode.commands.executeCommand('labwindowsCvi.editBuildSettings', { kind: 'project', ref });
        }
        return;
      }
    } else {
      rawExecutablePath = targetPath;
      if (!rawExecutablePath) {
        vscode.window.showErrorMessage(`The executable target for ${ref.name} could not be resolved from the CVI project.`);
        return;
      }
    }

    const projectDirectory = path.dirname(ref.absolutePath);
    const executablePath = this.resolveRuntimeReference(rawExecutablePath, projectDirectory);
    if (executablePath !== rawExecutablePath) {
      this.output.appendLine(`[CVI] Resolved runtime path: ${rawExecutablePath} -> ${executablePath}`);
    }
    if (path.extname(executablePath).toLowerCase() !== '.exe') {
      vscode.window.showErrorMessage(useExternalHost
        ? `Program Name must point to an executable (.exe). Current value: ${executablePath}`
        : `The built target is ${path.basename(executablePath)}, not an executable.`);
      return;
    }
    if (!fs.existsSync(executablePath)) {
      if (useExternalHost) {
        vscode.window.showErrorMessage(`The Program Name executable configured for this DLL project does not exist: ${executablePath}`);
        this.output.appendLine(`[CVI] DLL Program Name executable not found: ${executablePath}`);
      } else {
        vscode.window.showErrorMessage(`The executable does not exist: ${executablePath}. Use Build and Run to create the target before launching it.`);
        this.output.appendLine(`[CVI] Executable not found: ${executablePath}`);
      }
      return;
    }
    try {
      if (!fs.statSync(executablePath).isFile()) {
        vscode.window.showErrorMessage(`The configured executable path is not a regular file: ${executablePath}`);
        return;
      }
    } catch (error) {
      vscode.window.showErrorMessage(`The executable cannot be accessed: ${executablePath}. ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const fallbackArgs = vscode.workspace.getConfiguration('labwindowsCvi').get<string[]>('runArguments', []);
    const args = run.arguments.trim() ? this.projectSettings.parseArguments(run.arguments) : fallbackArgs;
    const configuredCwd = run.workingDirectory.trim();
    const cwd = configuredCwd ? this.resolveRuntimeReference(configuredCwd, projectDirectory) : path.dirname(executablePath);
    if (configuredCwd && cwd !== configuredCwd) {
      this.output.appendLine(`[CVI] Resolved working directory: ${configuredCwd} -> ${cwd}`);
    }
    if (!fs.existsSync(cwd)) {
      vscode.window.showErrorMessage(`The configured working directory does not exist: ${cwd}`);
      return;
    }
    try {
      if (!fs.statSync(cwd).isDirectory()) {
        vscode.window.showErrorMessage(`The configured working directory is not a directory: ${cwd}`);
        return;
      }
    } catch (error) {
      vscode.window.showErrorMessage(`The configured working directory cannot be accessed: ${cwd}. ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const renderedCommand = `${executablePath} ${args.map(renderArgument).join(' ')}`.trim();
    const child = spawn(executablePath, args, { cwd, env: this.projectSettings.parseEnvironment(run.environmentOptions), detached: true, shell: false, stdio: 'ignore' });
    child.once('spawn', () => this.output.appendLine(`[CVI] Started ${renderedCommand}`));
    child.once('error', (error) => {
      const message = `Unable to start ${executablePath}: ${error.message}`;
      this.output.appendLine(`[CVI] ${message}`);
      void vscode.window.showErrorMessage(message);
    });
    child.unref();
  }

  async debugInCvi(projectRef?: CviWorkspaceProjectRef): Promise<void> {
    const ref = projectRef ?? this.workspaces.activeProjectRef;
    if (!ref?.exists) {
      vscode.window.showErrorMessage('No existing CVI project is available for debugging.');
      return;
    }
    if (!await this.ensureDebugBuildMode(ref)) {
      return;
    }
    const success = await this.build(false, ref);
    if (!success) {
      return;
    }
    const workspace = this.workspaces.currentWorkspace;
    const synchronizeBreakpoints = vscode.workspace.getConfiguration('labwindowsCvi').get<boolean>('synchronizeBreakpointsBeforeNativeDebug', true);
    let synchronized = false;
    if (synchronizeBreakpoints && workspace && path.extname(workspace.path).toLowerCase() === '.cws') {
      synchronized = Boolean(await this.breakpoints.synchronize(ref, false));
    }
    await this.openInCvi(workspace?.path ?? ref.absolutePath, workspace);
    vscode.window.showInformationMessage(synchronized
      ? 'Debug build opened in CVI. Standard enabled VS Code breakpoints from the selected project were synchronized to the native CVI workspace. Use CVI for step commands, watch expressions and variable inspection.'
      : 'Debug build opened in CVI. Use CVI for breakpoints, step commands, watch expressions and variable inspection.');
  }

  async openWorkspaceInCvi(): Promise<void> {
    const workspace = this.workspaces.currentWorkspace;
    if (!workspace) {
      vscode.window.showErrorMessage('No CVI workspace is loaded.');
      return;
    }
    await this.openInCvi(workspace.path, workspace);
  }
  async openProjectInCvi(projectPath: string): Promise<void> { await this.openInCvi(projectPath, this.workspaces.currentWorkspace); }
  async prepareDllImportLibraryGeneration(headerPath: string): Promise<void> {
    if (path.extname(headerPath).toLowerCase() !== '.h' || !fs.existsSync(headerPath)) {
      vscode.window.showErrorMessage('Generate DLL Import Library is available only for an existing header file.');
      return;
    }
    const selected = await vscode.window.showOpenDialog({
      title: 'Select the DLL used to generate the CVI import library',
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { 'Dynamic Link Library': ['dll'] }
    });
    if (!selected?.[0]) {
      return;
    }
    await vscode.env.clipboard.writeText(selected[0].fsPath);
    await this.openInCvi(headerPath, this.workspaces.currentWorkspace, true);
    void vscode.window.showInformationMessage(
      'The header is open in LabWindows/CVI and the DLL path has been copied to the clipboard. In CVI, use Options > Generate DLL Import Library, then paste the DLL path when prompted.',
      'OK'
    );
  }

  async openPanelInCvi(panelPath: string): Promise<void> {
    if (!fs.existsSync(panelPath)) {
      vscode.window.showErrorMessage(`Panel not found: ${panelPath}`);
      return;
    }
    await this.openInCvi(panelPath, this.workspaces.currentWorkspace, true);
  }

  private beginOutput(label: string, mode: CviBuildMode = this.buildMode): CviBuildReport {
    const report: CviBuildReport = {
      label,
      startedAt: new Date(),
      startedMs: Date.now(),
      toolRuns: 0,
      errors: [],
      warnings: [],
      notes: [],
      projectTotal: 0,
      projectBuilt: 0
    };
    this.currentReport = report;
    this.diagnostics.clear();
    this.output.clear();
    this.traceOutput.clear();
    this.output.show(true);

    const detail = this.logDetail();
    this.output.appendLine('='.repeat(80));
    this.output.appendLine(` CVI BUILD  |  ${label}`);
    this.output.appendLine('='.repeat(80));
    this.output.appendLine(`  Mode      : ${mode}`);
    this.output.appendLine(`  Started   : ${formatDateTime(report.startedAt)}`);
    this.output.appendLine(`  Log detail: ${detail}`);
    this.output.appendLine('');
    this.output.appendLine('  Full compile.exe commands, CVI log files and raw tool output are available in:');
    this.output.appendLine('  Output -> LabWindows/CVI - Build Trace');
    this.output.appendLine('');

    this.traceOutput.appendLine('='.repeat(80));
    this.traceOutput.appendLine(` CVI BUILD TRACE  |  ${label}`);
    this.traceOutput.appendLine('='.repeat(80));
    this.traceOutput.appendLine(`Mode    : ${mode}`);
    this.traceOutput.appendLine(`Started : ${formatDateTime(report.startedAt)}`);
    this.traceOutput.appendLine('');
    return report;
  }

  private finishOutput(report: CviBuildReport, success: boolean, failedAt?: string): void {
    if (this.currentReport !== report) {
      return;
    }
    const durationMs = Date.now() - report.startedMs;
    this.output.appendLine('');
    this.output.appendLine('='.repeat(80));
    this.output.appendLine(success ? ' BUILD SUCCEEDED' : ' BUILD FAILED');
    this.output.appendLine('='.repeat(80));
    this.output.appendLine(`  Duration   : ${formatDuration(durationMs)}`);
    this.output.appendLine(`  Tool runs  : ${report.toolRuns}`);
    if (report.projectTotal > 0) {
      this.output.appendLine(`  Projects   : ${report.projectBuilt}/${report.projectTotal}`);
    }
    this.output.appendLine(`  Errors     : ${report.errors.length}`);
    this.output.appendLine(`  Warnings   : ${report.warnings.length}`);
    if (!success) {
      const firstError = report.errors[0];
      this.output.appendLine(`  Failed at  : ${failedAt || report.failedAt || 'unknown step'}`);
      if (firstError) {
        this.output.appendLine('  First error:');
        const location = formatDiagnosticLocation(firstError);
        if (location) {
          this.output.appendLine(`      ${location}`);
        }
        this.output.appendLine(`      ${firstError.message}`);
      }
      this.output.appendLine('');
      this.output.appendLine('  Next steps:');
      this.output.appendLine('    1. Fix the first ERROR block above; later diagnostics may be consequences.');
      this.output.appendLine('    2. Open View -> Problems for clickable CVI build diagnostics when a source location is available.');
      this.output.appendLine('    3. Use Output -> LabWindows/CVI - Build Trace for full compile.exe commands, raw output and retained CVI log paths.');
    }
    this.output.appendLine('='.repeat(80));

    this.traceOutput.appendLine('');
    this.traceOutput.appendLine('='.repeat(80));
    this.traceOutput.appendLine(success ? ' BUILD TRACE ENDED: SUCCESS' : ' BUILD TRACE ENDED: FAILURE');
    this.traceOutput.appendLine(`Duration: ${formatDuration(durationMs)}`);
    this.traceOutput.appendLine('='.repeat(80));
    this.currentReport = undefined;
  }

  private appendSection(title: string): void {
    const line = `--- ${title} ${'-'.repeat(Math.max(1, 76 - title.length))}`;
    this.output.appendLine(line);
  }

  private logDetail(): CviBuildLogDetail {
    const value = vscode.workspace.getConfiguration('labwindowsCvi').get<string>('buildLogDetail', 'normal');
    return value === 'compact' || value === 'normal' || value === 'verbose' ? value : 'normal';
  }

  showBuildProblems(): void {
    void vscode.commands.executeCommand('workbench.actions.view.problems');
  }

  showFullBuildTrace(): void {
    this.traceOutput.show(true);
  }

  private async requireInstallation(): Promise<CviInstallation | undefined> {
    let installation = this.installations.getActiveInstallation(this.workspaces.currentWorkspace?.cviDir);
    if (!installation) installation = await this.installations.selectInstallation(this.workspaces.currentWorkspace?.cviDir);
    if (!installation) {
      vscode.window.showErrorMessage('A LabWindows/CVI installation is required to resolve CVI headers and external support libraries.');
      return undefined;
    }
    return installation;
  }

  private async requireCompiler(): Promise<CviInstallation | undefined> {
    let installation = this.installations.getActiveInstallation(this.workspaces.currentWorkspace?.cviDir);
    if (!installation?.compileExe) {
      installation = await this.installations.selectInstallation(this.workspaces.currentWorkspace?.cviDir);
    }
    if (!installation?.compileExe) {
      vscode.window.showErrorMessage('compile.exe was not found. Select the correct LabWindows/CVI installation directory.');
      return undefined;
    }
    return installation;
  }

  private resolveRuntimeReference(value: string, baseDirectory: string): string {
    const normalized = normalizeRuntimePath(value);
    if (!normalized) {
      return '';
    }
    if (path.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) {
      return normalized;
    }
    return normalizeRuntimePath(resolveCviReferencePath(baseDirectory, normalized));
  }

  private get customBuildConfiguration(): string {
    const raw = vscode.workspace.getConfiguration('labwindowsCvi').get<string>('customBuildConfiguration', '').trim();
    if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
      return raw.slice(1, -1).trim();
    }
    return raw;
  }

  private commonCompilerArguments(rebuild: boolean, mode: CviBuildMode = this.buildMode, customConfig = this.customBuildConfiguration): string[] {
    const config = vscode.workspace.getConfiguration('labwindowsCvi');
    const rawExtraArguments = config.get<string[]>('extraCompilerArguments', []);
    const { arguments: extraArguments, ignored } = sanitizeExtraCompilerArguments(rawExtraArguments);

    // NI documents named configurations as `compile <project> -config=<name>`.
    // Do not combine -config with -debug/-release: they are two competing ways to
    // select the build configuration. Dependency projects intentionally keep their
    // own native workspace mode unless they are the explicitly requested project.
    const args: string[] = customConfig ? [`-config=${customConfig}`] : [`-${mode}`];
    if (rebuild) args.push('-rebuild');
    args.push(...extraArguments);

    if (ignored.length > 0) {
      const message = `Ignored extension-managed compile.exe argument(s): ${ignored.map(renderArgument).join(' ')}. Use Build Mode / Custom Build Configuration instead of duplicating -debug/-release/-config/-rebuild/-log in extraCompilerArguments.`;
      this.traceOutput.appendLine(`[CVI] ${message}`);
      if (this.logDetail() !== 'compact') this.output.appendLine(`  [!] ${message}`);
    }
    return args;
  }

  private async runExternalMsvcBuild(
    ref: CviWorkspaceProjectRef,
    project: ReturnType<CviWorkspaceService['getProject']>,
    mode: CviBuildMode,
    customConfiguration: string,
    targetPath: string,
    compilerSettings: ReturnType<CviParser['getNativeCompilerSettings']> | undefined,
    projectCompilerSettings: ReturnType<CviParser['getProjectCompilerSettings']> | undefined,
    external: CviExternalBuildSettings,
    installation: CviInstallation,
    rebuild: boolean
  ): Promise<CviToolRunResult> {
    const label = `${rebuild ? 'External Rebuild' : 'External Build'} ${ref.name}`;
    const cwd = path.dirname(ref.absolutePath);
    if (process.platform !== 'win32') {
      return this.externalSyntheticResult(label, 'Microsoft Visual C++ external builds are available only on Windows.');
    }
    if (!project) return this.externalSyntheticResult(label, 'The CVI project model is not available.');
    if (!targetPath) return this.externalSyntheticResult(label, 'The target output path could not be resolved from the CVI project.');

    const vcvarsall = this.findVcvarsall(external.vcvarsallPath);
    if (!vcvarsall) {
      return this.externalSyntheticResult(label, 'vcvarsall.bat was not found. Install Visual Studio/Build Tools with the Desktop development with C++ workload, or set the path in External Compiler settings.');
    }
    const is64 = mode === 'debug64' || mode === 'release64';
    const debug = mode === 'debug' || mode === 'debug64';
    const configName = customConfiguration || mode;
    const configuredBuildDir = external.buildDirectory.trim();
    const buildDir = configuredBuildDir
      ? this.resolveRuntimeReference(configuredBuildDir, cwd)
      : path.join(path.dirname(this.projectSettings.getConfigurationPath() ?? path.join(cwd, '.vscode', 'x')), 'cvi-external-build', path.basename(ref.absolutePath, path.extname(ref.absolutePath)), sanitizeFilePart(configName));
    if (rebuild) {
      try { fs.rmSync(buildDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    fs.mkdirSync(buildDir, { recursive: true });
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    const cviInclude = path.join(installation.root, 'include');
    const cviExtlib = path.join(installation.root, 'extlib', is64 ? 'msvc64' : 'msvc');
    const cvirt = path.join(cviExtlib, 'cvirt.lib');
    const cvisupp = path.join(cviExtlib, 'cvisupp.lib');
    if (!fs.existsSync(cviInclude) || !fs.existsSync(cvirt) || !fs.existsSync(cvisupp)) {
      return this.externalSyntheticResult(label, `CVI external compiler support files were not found. Expected include=${cviInclude}, cvirt=${cvirt}, cvisupp=${cvisupp}.`);
    }

    const sourceRefs = project.files.filter((file) => !file.excluded && path.extname(file.absolutePath).toLowerCase() === '.c');
    const missingSources = sourceRefs.filter((file) => !fs.existsSync(file.absolutePath));
    if (missingSources.length > 0) return this.externalSyntheticResult(label, `External build cannot continue because ${missingSources.length} C source file(s) are missing: ${missingSources.slice(0, 4).map((file) => file.absolutePath).join(', ')}`);
    const sources = sourceRefs;
    if (sources.length === 0) return this.externalSyntheticResult(label, 'No C source file is available for the external MSVC build.');
    const objectRefs = project.files.filter((file) => !file.excluded && path.extname(file.absolutePath).toLowerCase() === '.obj');
    const libraryRefs = project.files.filter((file) => !file.excluded && path.extname(file.absolutePath).toLowerCase() === '.lib');
    const missingLinkInputs = [...objectRefs, ...libraryRefs].filter((file) => !fs.existsSync(file.absolutePath));
    if (missingLinkInputs.length > 0) return this.externalSyntheticResult(label, `External build cannot continue because ${missingLinkInputs.length} object/library input(s) are missing: ${missingLinkInputs.slice(0, 4).map((file) => file.absolutePath).join(', ')}`);
    const objectInputs = objectRefs.map((file) => file.absolutePath);
    const libraryInputs = libraryRefs.map((file) => file.absolutePath);
    if (debug && libraryInputs.length > 0) {
      this.recordSyntheticWarning(label, 'External Debug build references .lib files. NI documents that static libraries created by CVI in a Debug configuration are not supported outside LabWindows/CVI; verify each library is MSVC-compatible (release/import/vendor library).', ref.absolutePath);
    }
    const includePaths = uniquePaths([
      cwd,
      ...sources.map((file) => path.dirname(file.absolutePath)),
      ...(projectCompilerSettings?.includePaths ?? []),
      cviInclude
    ]);
    const defines = parseCviDefineOptions(compilerSettings?.compilerDefines ?? '');
    const compileExtras = splitWindowsArguments(external.additionalCompilerOptions);
    const linkExtras = splitWindowsArguments(external.additionalLinkerOptions);
    const additionalLibraries = external.additionalLibraries.map((entry) => this.resolveRuntimeReference(entry, cwd)).filter(Boolean);

    const support = this.parser.getExternalCompilerSupportSettings(ref.absolutePath);
    const supportSources: string[] = [];
    const supportObjects: string[] = [];
    if (external.useCviExternalSupportFiles) {
      const callbackFile = support.uirCallbacksObjFile;
      if (callbackFile && fs.existsSync(callbackFile)) {
        if (path.extname(callbackFile).toLowerCase() === '.c') supportSources.push(callbackFile); else supportObjects.push(callbackFile);
      } else if (project.files.some((file) => path.extname(file.absolutePath).toLowerCase() === '.uir')) {
        this.recordSyntheticWarning(label, 'This project contains UIR resources but no generated UIR callback source/object file is available. Generate it in CVI Build > External Compiler Support when the UIR contains callbacks.', ref.absolutePath);
      }
      if (support.usingLoadExternalModule) {
        if (support.projectSymbolsObjFile && fs.existsSync(support.projectSymbolsObjFile)) supportObjects.push(support.projectSymbolsObjFile);
        else this.recordSyntheticWarning(label, 'Using LoadExternalModule is enabled but the generated Project Symbols object file is missing.', ref.absolutePath);
      }
    }

    const allSources = [...sources.map((file) => file.absolutePath), ...supportSources];
    if (!allSources.some((file) => sourceContainsToken(file, /\bInitCVIRTE\s*\(/))) {
      this.recordSyntheticWarning(label, 'NI requires externally linked CVI executables/DLLs to call InitCVIRTE at startup. No InitCVIRTE call was detected in the project sources.', ref.absolutePath);
    }
    if (project.targetType === 'Dynamic Link Library' && !allSources.some((file) => sourceContainsToken(file, /\bCloseCVIRTE\s*\(/))) {
      this.recordSyntheticWarning(label, 'NI requires externally linked CVI DLLs to call CloseCVIRTE from the DLL entry-point lifecycle. No CloseCVIRTE call was detected.', ref.absolutePath);
    }

    const objects: string[] = [];
    for (let index = 0; index < allSources.length; index += 1) {
      const source = allSources[index];
      const objectPath = path.join(buildDir, `${String(index + 1).padStart(3, '0')}-${sanitizeFilePart(path.basename(source, path.extname(source)))}.obj`);
      const args = [
        '/nologo', '/TC', '/c', source, `/Fo${objectPath}`,
        debug ? '/Od' : '/O2', debug ? '/Z7' : '/DNDEBUG', '/W3',
        ...includePaths.map((entry) => `/I${entry}`),
        ...defines.map((entry) => `/D${entry}`),
        ...(projectCompilerSettings?.precompilePrefixHeader && projectCompilerSettings.prefixHeaderFile ? [`/FI${projectCompilerSettings.prefixHeaderFile}`] : []),
        ...compileExtras
      ];
      const result = await this.runMsvcTool(vcvarsall, is64 ? 'x64' : 'x86', 'cl.exe', args, cwd, `${label} — compile ${path.basename(source)}`, buildDir);
      if (!result.success) return result;
      objects.push(objectPath);
    }

    const commonInputs = [...objects, ...objectInputs, ...supportObjects, ...libraryInputs, ...additionalLibraries];
    if (project.targetType === 'Static Library') {
      return await this.runMsvcTool(vcvarsall, is64 ? 'x64' : 'x86', 'lib.exe', ['/nologo', `/OUT:${targetPath}`, ...commonInputs], cwd, `${label} — librarian`, buildDir);
    }
    const pdb = replaceExtension(targetPath, '.pdb');
    const linkArgs = ['/NOLOGO', `/OUT:${targetPath}`, ...(debug ? ['/DEBUG', `/PDB:${pdb}`] : []), ...(project.targetType === 'Dynamic Link Library' ? ['/DLL'] : []), ...commonInputs, cvirt, cvisupp, ...linkExtras];
    return await this.runMsvcTool(vcvarsall, is64 ? 'x64' : 'x86', 'link.exe', linkArgs, cwd, `${label} — link`, buildDir);
  }

  private findVcvarsall(configured: string): string | undefined {
    const explicit = configured.trim();
    if (explicit && fs.existsSync(explicit)) return explicit;
    const vsInstall = process.env.VSINSTALLDIR;
    if (vsInstall) {
      const candidate = path.join(vsInstall, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat');
      if (fs.existsSync(candidate)) return candidate;
    }
    const vswhere = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    if (fs.existsSync(vswhere)) {
      try {
        const installPath = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true }).trim();
        if (installPath) {
          const candidate = path.join(installPath, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat');
          if (fs.existsSync(candidate)) return candidate;
        }
      } catch { /* ignored */ }
    }
    return undefined;
  }

  private async runMsvcTool(vcvarsall: string, architecture: 'x86' | 'x64', tool: string, args: string[], cwd: string, label: string, buildDir: string): Promise<CviToolRunResult> {
    fs.mkdirSync(buildDir, { recursive: true });
    const rsp = path.join(buildDir, `${sanitizeFilePart(label)}.rsp`);
    fs.writeFileSync(rsp, args.map(msvcResponseArgument).join('\r\n') + '\r\n', 'utf8');
    const command = `call "${vcvarsall}" ${architecture} >nul && ${tool} @"${rsp}"`;
    return await this.runExternalTool('cmd.exe', ['/d', '/s', '/c', command], cwd, label);
  }

  private async runExternalTool(executable: string, args: string[], cwd: string, label: string): Promise<CviToolRunResult> {
    const started = Date.now();
    this.traceOutput.appendLine(`--- ${label} ${'-'.repeat(Math.max(1, 76 - label.length))}`);
    this.traceOutput.appendLine(`Tool             : ${executable}`);
    this.traceOutput.appendLine(`Working directory: ${cwd}`);
    this.traceOutput.appendLine(`Arguments        : ${args.map(renderArgument).join(' ')}`);
    this.traceOutput.appendLine('');
    return await new Promise<CviToolRunResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (code: number | null, launchError?: Error): void => {
        if (settled) return;
        settled = true;
        const combined = [stdout, stderr].filter(Boolean).join('\n');
        const diagnostics = launchError
          ? [{ severity: 'error' as const, message: launchError.message, toolLabel: label, rawLine: launchError.message }]
          : parseCviDiagnostics(combined, label, cwd);
        if (!launchError && code !== 0 && !diagnostics.some((item) => item.severity === 'error')) diagnostics.push({ severity: 'error', message: `${label} exited with code ${String(code)}.`, toolLabel: label, rawLine: combined.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? `Exit code ${String(code)}` });
        const result: CviToolRunResult = { success: !launchError && code === 0, code, stdout, stderr, logText: '', logFile: '', durationMs: Date.now() - started, diagnostics };
        this.recordToolResult(label, executable, args, cwd, result);
        resolve(result);
      };
      const child = spawn(executable, args, { cwd, windowsHide: true, shell: false });
      this.activeCompilerChildren.add(child);
      child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); this.traceOutput.append(data.toString()); });
      child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); this.traceOutput.append(data.toString()); });
      child.on('error', (error) => { this.activeCompilerChildren.delete(child); finish(null, error); });
      child.on('close', (code) => { this.activeCompilerChildren.delete(child); finish(code); });
    });
  }

  private externalSyntheticResult(label: string, message: string): CviToolRunResult {
    const result: CviToolRunResult = { success: false, code: null, stdout: '', stderr: message, logText: '', logFile: '', durationMs: 0, diagnostics: [{ severity: 'error', message, toolLabel: label, rawLine: message }] };
    this.recordToolResult(label, 'MSVC external build', [], '', result);
    return result;
  }

  private async runCviCompile(compileExe: string, args: string[], cwd: string, label: string): Promise<CviToolRunResult> {
    const logFile = this.createBuildLogPath(cwd, label);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    try { fs.rmSync(logFile, { force: true }); } catch { /* ignored */ }
    const allArgs = [...args, '-log', logFile];
    const started = Date.now();
    const detail = this.logDetail();

    this.traceOutput.appendLine(`--- ${label} ${'-'.repeat(Math.max(1, 76 - label.length))}`);
    this.traceOutput.appendLine(`Tool             : ${compileExe}`);
    this.traceOutput.appendLine(`Working directory: ${cwd}`);
    this.traceOutput.appendLine(`Arguments        : ${allArgs.map(renderArgument).join(' ')}`);
    this.traceOutput.appendLine(`CVI log file     : ${logFile}`);
    this.traceOutput.appendLine('');

    if (detail === 'verbose') {
      this.output.appendLine(`  [RUN] ${label}`);
      this.output.appendLine(`      Tool      : ${compileExe}`);
      this.output.appendLine(`      Arguments : ${allArgs.map(renderArgument).join(' ')}`);
      this.output.appendLine(`      Log file  : ${logFile}`);
      this.output.appendLine('');
    }

    return await new Promise<CviToolRunResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let logText = '';
      let logOffset = 0;
      let closed = false;
      const drainLog = (): void => {
        if (!fs.existsSync(logFile)) return;
        try {
          const data = fs.readFileSync(logFile);
          if (data.length > logOffset) {
            const chunk = data.subarray(logOffset).toString();
            this.traceOutput.append(chunk);
            logText += chunk;
            logOffset = data.length;
          }
        } catch { /* log file may be temporarily locked by CVI */ }
      };
      const timer = setInterval(drainLog, 150);
      this.activeLogTimers.add(timer);
      const finish = (code: number | null, launchError?: Error): void => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        this.activeLogTimers.delete(timer);
        if (this.disposed) {
          resolve({ success: false, code, stdout, stderr, logText, logFile, durationMs: Date.now() - started, diagnostics: [] });
          return;
        }
        drainLog();
        const durationMs = Date.now() - started;
        const combinedOutput = [stdout, stderr, logText].filter(Boolean).join('\n');
        const diagnostics = launchError
          ? [{ severity: 'error' as const, message: `Unable to start ${compileExe}: ${launchError.message}`, toolLabel: label, rawLine: launchError.message, hint: 'Check that the LabWindows/CVI installation path is valid and that compile.exe can be launched from VS Code.' }]
          : parseCviDiagnostics(combinedOutput, label, cwd);
        if (!launchError && code !== 0 && !diagnostics.some((item) => item.severity === 'error')) {
          diagnostics.push({
            severity: 'error',
            message: `${path.basename(compileExe)} exited with code ${String(code)} without a recognized source diagnostic.`,
            toolLabel: label,
            rawLine: combinedOutput.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? `Exit code ${String(code)}`,
            hint: 'Open LabWindows/CVI - Build Trace and inspect the retained CVI log. The failure may come from a build step, linker, project configuration, licensing, or an older CVI diagnostic format.'
          });
        }
        const result: CviToolRunResult = { success: !launchError && code === 0, code, stdout, stderr, logText, logFile, durationMs, diagnostics };
        this.recordToolResult(label, compileExe, allArgs, cwd, result);
        if (launchError) {
          vscode.window.showErrorMessage(`Unable to start LabWindows/CVI compiler: ${launchError.message}`);
        } else if (code !== 0) {
          vscode.window.showErrorMessage(`${label} failed. Open the LabWindows/CVI output channel for details.`);
        }
        resolve(result);
      };
      const child = spawn(compileExe, allArgs, { cwd, windowsHide: true, shell: false });
      this.activeCompilerChildren.add(child);
      child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); this.traceOutput.append(data.toString()); });
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); this.traceOutput.append(data.toString()); });
      child.on('error', (error) => { this.activeCompilerChildren.delete(child); finish(null, error); });
      child.on('close', (code) => { this.activeCompilerChildren.delete(child); finish(code); });
    });
  }

  private recordToolResult(label: string, executable: string, args: string[], cwd: string, result: CviToolRunResult): void {
    const report = this.currentReport;
    if (report) {
      report.toolRuns += 1;
      const errors = result.diagnostics.filter((item) => item.severity === 'error');
      const warnings = result.diagnostics.filter((item) => item.severity === 'warning');
      const notes = result.diagnostics.filter((item) => item.severity === 'note');
      report.errors.push(...errors);
      report.warnings.push(...warnings);
      report.notes.push(...notes);
      if (!result.success && !report.failedAt) {
        report.failedAt = label;
      }
      this.publishCurrentDiagnostics(report);
    }

    // stdout/stderr and the CVI -log file are streamed live into the trace while
    // compile.exe is running. Do not replay their complete contents here: doing so
    // duplicated every diagnostic and could double very large build traces.
    this.traceOutput.appendLine('');
    this.traceOutput.appendLine('Capture summary:');
    this.traceOutput.appendLine(`  stdout bytes : ${Buffer.byteLength(result.stdout)}`);
    this.traceOutput.appendLine(`  stderr bytes : ${Buffer.byteLength(result.stderr)}`);
    this.traceOutput.appendLine(`  tool log bytes: ${Buffer.byteLength(result.logText)}`);
    if (result.logFile) this.traceOutput.appendLine(`  tool log file : ${result.logFile}`);
    this.traceOutput.appendLine(`  Exit code    : ${String(result.code)}`);
    this.traceOutput.appendLine(`  Duration     : ${formatDuration(result.durationMs)}`);
    this.traceOutput.appendLine('');

    const status = result.success ? '[OK]' : '[X]';
    const detail = result.code !== 0 && result.code !== null ? `exit code ${result.code}, ${formatDuration(result.durationMs)}` : formatDuration(result.durationMs);
    const line = `  ${status} ${label}${result.success ? '' : ' FAILED'} (${detail})`;
    if (!result.success || this.logDetail() !== 'compact') {
      this.output.appendLine(line);
    }

    if (this.logDetail() === 'verbose') {
      const raw = [result.stdout, result.stderr, result.logText].filter(Boolean).join('\n').trimEnd();
      if (raw.length > 0) {
        this.output.appendLine('      Raw output:');
        this.output.appendLine(indentBlock(raw, '      '));
      }
    }

    if (!result.success) {
      this.renderDiagnostics(result.diagnostics, result.stdout, result.stderr, result.logText);
    } else if (result.diagnostics.some((item) => item.severity === 'warning') && this.logDetail() !== 'compact') {
      this.renderDiagnostics(result.diagnostics.filter((item) => item.severity === 'warning'), result.stdout, result.stderr, result.logText);
    }
  }

  private recordSyntheticWarning(label: string, message: string, file?: string): void {
    const report = this.currentReport;
    if (!report) {
      return;
    }
    report.warnings.push({
      severity: 'warning',
      file,
      message,
      toolLabel: label,
      rawLine: message,
      hint: 'Review the selected CVI build configuration in CVI Project Build Settings.'
    });
  }

  private recordSyntheticFailure(label: string, message: string): void {
    const report = this.currentReport;
    if (!report) {
      return;
    }
    const diagnostic: ParsedCviDiagnostic = {
      severity: 'error',
      message,
      toolLabel: label,
      rawLine: message,
      hint: 'Check the configured build action command, working directory and environment options.'
    };
    report.errors.push(diagnostic);
    if (!report.failedAt) {
      report.failedAt = label;
    }
  }

  private renderDiagnostics(diagnostics: ParsedCviDiagnostic[], stdout: string, stderr: string, logText: string): void {
    const errors = diagnostics.filter((item) => item.severity === 'error');
    const warnings = diagnostics.filter((item) => item.severity === 'warning');
    const relevant = [...errors, ...warnings];
    if (relevant.length === 0) {
      const raw = [stdout, stderr, logText].filter(Boolean).join('\n').trim();
      if (raw.length > 0) {
        this.output.appendLine('  ------------------------------------------------------------------------------');
        this.output.appendLine('  Raw tool output excerpt:');
        this.output.appendLine(indentBlock(raw.split(/\r?\n/).slice(0, 24).join('\n'), '      '));
      }
      this.output.appendLine('');
      return;
    }

    this.output.appendLine('  ------------------------------------------------------------------------------');
    relevant.forEach((diagnostic, index) => {
      const tag = diagnostic.severity === 'warning' ? 'WARNING' : 'ERROR';
      this.output.appendLine(`  [X] ${tag} ${index + 1}/${relevant.length}`);
      const location = formatDiagnosticLocation(diagnostic);
      if (location) {
        this.output.appendLine(`      Location : ${location}`);
      }
      if (diagnostic.code) {
        this.output.appendLine(`      Code     : ${diagnostic.code}`);
      }
      this.output.appendLine(`      Message  : ${diagnostic.message}`);
      if (diagnostic.sourceLine) {
        this.output.appendLine(`      Source   : ${diagnostic.sourceLine.trim()}`);
      }
      if (diagnostic.hint) {
        this.output.appendLine('      Hint     : ' + diagnostic.hint.replace(/\n/g, '\n                 '));
      }
      this.output.appendLine('');
    });
    this.output.appendLine('  Full command, complete CVI log path and unfiltered output:');
    this.output.appendLine('  Output -> LabWindows/CVI - Build Trace');
    this.output.appendLine('');
  }

  private publishCurrentDiagnostics(report: CviBuildReport): void {
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const item of [...report.errors, ...report.warnings]) {
      if (!item.file) {
        continue;
      }
      const normalizedFile = normalizeRuntimePath(item.file);
      const zeroLine = Math.max(0, (item.line ?? 1) - 1);
      const zeroColumn = Math.max(0, (item.column ?? 1) - 1);
      const range = new vscode.Range(zeroLine, zeroColumn, zeroLine, Math.max(zeroColumn + 1, zeroColumn + (item.sourceLine?.trim().length ?? 1)));
      const severity = item.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error;
      const diagnostic = new vscode.Diagnostic(range, item.hint ? `${item.message}\n\nHint: ${item.hint}` : item.message, severity);
      diagnostic.source = 'CVI Build';
      if (item.code) {
        diagnostic.code = item.code;
      }
      const existing = byFile.get(normalizedFile) ?? [];
      existing.push(diagnostic);
      byFile.set(normalizedFile, existing);
    }
    this.diagnostics.clear();
    for (const [filePath, values] of byFile) {
      this.diagnostics.set(vscode.Uri.file(filePath), values);
    }
  }

  private createBuildLogPath(cwd: string, label: string): string {
    const root = this.projectSettings.getConfigurationPath();
    const base = root ? path.dirname(root) : path.join(cwd, '.vscode');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safe = label.replace(/[^A-Za-z0-9_-]+/g, '-');
    return path.join(base, 'cvi-build-logs', `${stamp}-${safe}.log`);
  }

  private async openInCvi(filePath: string, workspace?: CviWorkspace, allowExternalFallback = false): Promise<void> {
    let installation = this.installations.getActiveInstallation(workspace?.cviDir);
    if (!installation?.ideExe) installation = await this.installations.selectInstallation(workspace?.cviDir);
    if (installation?.ideExe) {
      const child = spawn(installation.ideExe, [filePath], { cwd: path.dirname(filePath), detached: true, shell: false, stdio: 'ignore' });
      child.unref();
      return;
    }
    if (allowExternalFallback && await vscode.env.openExternal(vscode.Uri.file(filePath))) return;
    vscode.window.showErrorMessage('cvi.exe was not found. Select the correct LabWindows/CVI installation directory.');
  }
}


function countCompiledSources(files: Array<{ absolutePath: string; excluded: boolean; compileIntoObjectFile: boolean }>): number {
  return files.filter((file) => !file.excluded && file.compileIntoObjectFile && path.extname(file.absolutePath).toLowerCase() === '.c').length;
}

function formatDateTime(date: Date): string {
  return date.toLocaleString();
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms} ms`;
  }
  return `${(ms / 1000).toFixed(2)} s`;
}

function indentBlock(text: string, prefix: string): string {
  return text.split(/\r?\n/).map((line) => `${prefix}${line}`).join('\n');
}

function formatDiagnosticLocation(diagnostic: ParsedCviDiagnostic): string {
  if (!diagnostic.file) {
    return '';
  }
  if (diagnostic.line !== undefined && diagnostic.column !== undefined) {
    return `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}`;
  }
  if (diagnostic.line !== undefined) {
    return `${diagnostic.file}:${diagnostic.line}`;
  }
  return diagnostic.file;
}

function parseCviDiagnostics(output: string, toolLabel: string, baseDirectory = ''): ParsedCviDiagnostic[] {
  const diagnostics: ParsedCviDiagnostic[] = [];
  const lines = output.split(/\r?\n/);
  const gccLocation = /^(.+?):(\d+):(\d+):\s*(fatal error|error|warning|note):\s*(.+)$/i;
  const gccLocationNoColumn = /^(.+?):(\d+):\s*(fatal error|error|warning|note):\s*(.+)$/i;
  const msvcLocation = /^(.+?)\((\d+)(?:,(\d+))?\):\s*(fatal error|error|warning)\s*([A-Z]+\d+)?\s*:\s*(.+)$/i;
  const cviQuotedLocation = /^"?([^"\r\n]+?\.(?:c|h|uir|prj))"?\s*,?\s*line\s+(\d+)(?:\s*,?\s*column\s+(\d+))?\s*[:\-]\s*(fatal error|error|warning|note)\s*[:\-]?\s*(.+)$/i;
  const cviLocation = /^(.+?\.(?:c|h|uir|prj))\s*\((\d+)(?:\s*,\s*(\d+))?\)\s*[:\-]\s*(fatal error|error|warning|note)\s*[:\-]?\s*(.+)$/i;
  const cviLineLocation = /^\s*"?([^"\r\n]+?\.(?:c|h|uir|prj))"?\s*[:,-]?\s*line\s+(\d+)(?:\s*[,;]\s*(?:column\s+)?(\d+))?\s*[:\-]\s*(fatal error|error|warning|note)\s*[:\-]?\s*(.+)$/i;
  const cviCodeFirst = /^(fatal error|error|warning|note)\s*(?:([A-Z]+\d+|\-?\d+)\s*)?[:\-]\s*(.+)$/i;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    let match = line.match(gccLocation);
    if (match) {
      const message = match[5].trim();
      diagnostics.push({
        severity: normalizeSeverity(match[4]),
        file: resolveDiagnosticFile(match[1], baseDirectory),
        line: Number(match[2]),
        column: Number(match[3]),
        message,
        sourceLine: findLikelySourceLine(lines, index + 1),
        hint: hintForDiagnostic(message),
        toolLabel,
        rawLine: line
      });
      continue;
    }
    match = line.match(gccLocationNoColumn);
    if (match) {
      const message = match[4].trim();
      diagnostics.push({
        severity: normalizeSeverity(match[3]),
        file: resolveDiagnosticFile(match[1], baseDirectory),
        line: Number(match[2]),
        message,
        sourceLine: findLikelySourceLine(lines, index + 1),
        hint: hintForDiagnostic(message),
        toolLabel,
        rawLine: line
      });
      continue;
    }
    match = line.match(msvcLocation);
    if (match) {
      const message = match[6].trim();
      diagnostics.push({
        severity: normalizeSeverity(match[4]),
        file: resolveDiagnosticFile(match[1], baseDirectory),
        line: Number(match[2]),
        column: match[3] ? Number(match[3]) : undefined,
        code: match[5]?.trim(),
        message,
        sourceLine: findLikelySourceLine(lines, index + 1),
        hint: hintForDiagnostic(message),
        toolLabel,
        rawLine: line
      });
      continue;
    }
    match = line.match(cviQuotedLocation) ?? line.match(cviLocation) ?? line.match(cviLineLocation);
    if (match) {
      const message = match[5].trim();
      diagnostics.push({
        severity: normalizeSeverity(match[4]),
        file: resolveDiagnosticFile(match[1], baseDirectory),
        line: Number(match[2]),
        column: match[3] ? Number(match[3]) : undefined,
        message,
        sourceLine: findLikelySourceLine(lines, index + 1),
        hint: hintForDiagnostic(message),
        toolLabel,
        rawLine: line
      });
      continue;
    }

    if (/CVI could not execute one or more of your build steps|build (?:step|action).*(?:failed|error)/i.test(line)) {
      const message = line.trim();
      diagnostics.push({
        severity: 'error',
        message,
        hint: hintForDiagnostic(`build step ${message}`),
        toolLabel,
        rawLine: line
      });
      continue;
    }

    const linkerDiagnostic = parseLinkerDiagnostic(line, toolLabel);
    if (linkerDiagnostic) {
      diagnostics.push(linkerDiagnostic);
      continue;
    }

    match = line.trim().match(cviCodeFirst);
    if (match && isLikelyCviDiagnosticLine(line)) {
      const message = match[3].trim();
      diagnostics.push({
        severity: normalizeSeverity(match[1]),
        code: match[2]?.trim(),
        message,
        hint: hintForDiagnostic(message),
        toolLabel,
        rawLine: line
      });
    }
  }

  return coalesceDiagnostics(diagnostics);
}

function resolveDiagnosticFile(fileValue: string, baseDirectory: string): string {
  const raw = fileValue.trim().replace(/^"|"$/g, '');
  if (!raw) return raw;
  const normalized = normalizeRuntimePath(raw);
  if (path.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) {
    return normalized;
  }
  if (!baseDirectory) return normalized;
  return normalizeRuntimePath(resolveCviReferencePath(baseDirectory, raw));
}

function sanitizeExtraCompilerArguments(values: string[]): { arguments: string[]; ignored: string[] } {
  const result: string[] = [];
  const ignored: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = String(values[index] ?? '').trim();
    if (!value) continue;
    const lower = value.toLowerCase();
    const managedMode = /^-(?:debug|release|debug64|release64|rebuild)$/i.test(value);
    const managedConfig = /^-config(?:=|$)/i.test(value);
    const managedLog = /^-log(?:=|$)/i.test(value);
    if (managedMode || managedConfig || managedLog) {
      ignored.push(value);
      if ((lower === '-config' || lower === '-log') && index + 1 < values.length) {
        ignored.push(String(values[++index] ?? ''));
      }
      continue;
    }
    result.push(value);
  }
  return { arguments: result, ignored };
}

function normalizeSeverity(value: string): ParsedCviDiagnostic['severity'] {
  if (/warning/i.test(value)) {
    return 'warning';
  }
  if (/note/i.test(value)) {
    return 'note';
  }
  return 'error';
}

function findLikelySourceLine(lines: string[], start: number): string | undefined {
  for (let index = start; index < Math.min(lines.length, start + 3); index++) {
    const candidate = lines[index]?.trimEnd();
    if (!candidate || /^\s*\^/.test(candidate) || /^\s*~/.test(candidate)) {
      continue;
    }
    if (/^(?:In file included from|from )/i.test(candidate)) {
      continue;
    }
    if (/^.+?:\d+(:\d+)?:\s*(fatal error|error|warning|note):/i.test(candidate)) {
      continue;
    }
    return candidate;
  }
  return undefined;
}

function parseLinkerDiagnostic(line: string, toolLabel: string): ParsedCviDiagnostic | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  const patterns: Array<{ regex: RegExp; message?: (match: RegExpMatchArray) => string }> = [
    { regex: /undefined reference to [`'](.+?)[`']/i, message: (match) => `undefined reference to ${match[1]}` },
    { regex: /unresolved external symbol\s+(.+)/i, message: (match) => `unresolved external symbol ${match[1]}` },
    { regex: /cannot find\s+(-l\S+)/i, message: (match) => `cannot find ${match[1]}` },
    { regex: /cannot open (?:input )?file\s+[`']?(.+?)[`']?$/i, message: (match) => `cannot open input file ${match[1]}` },
    { regex: /multiple definition of [`'](.+?)[`']/i, message: (match) => `multiple definition of ${match[1]}` },
    { regex: /ld(?:\.exe)?:\s+cannot find\s+(.+)/i, message: (match) => `cannot find ${match[1]}` },
    { regex: /collect2(?:\.exe)?: error: ld returned \d+ exit status/i },
    { regex: /link(?:\.exe)?\s*:\s*fatal error/i }
  ];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern.regex);
    if (match) {
      const message = pattern.message ? pattern.message(match) : trimmed;
      return {
        severity: 'error',
        message,
        hint: hintForDiagnostic(message),
        toolLabel,
        rawLine: line
      };
    }
  }
  return undefined;
}

function hintForDiagnostic(message: string): string | undefined {
  const lower = message.toLowerCase();
  if (lower.includes('undeclared identifier') || lower.includes('not declared in this scope')) {
    return 'The identifier is used without a visible declaration. Check the variable name, include the declaring header, or use the correct object/member scope.';
  }
  if (lower.includes('missing prototype') || lower.includes('implicit declaration')) {
    return 'A function is called without a visible prototype. Include the correct header or generate/update prototypes for the CVI source file.';
  }
  if (lower.includes('incompatible pointer') || lower.includes('different levels of indirection')) {
    return 'Check pointer type, address-of/dereference usage and CVI API parameter types. This often comes from passing a value where a pointer is expected, or the reverse.';
  }
  if (lower.includes('too few arguments') || lower.includes('too many arguments') || lower.includes('argument') && lower.includes('incompatible')) {
    return 'The call does not match the function prototype. Check argument count, order, pointer/reference usage and CVI control/panel handle types.';
  }
  if (lower.includes('undefined reference') || lower.includes('unresolved external symbol')) {
    return 'This is a linker error. Add the source/object/library that defines the symbol, or add the missing .lib/.obj/.c file in the CVI project build settings.';
  }
  if (lower.includes('cannot find -l') || lower.includes('cannot open input file')) {
    return 'The linker cannot locate a required library or object file. Check library paths, x86/x64 architecture, generated import libraries and project dependencies.';
  }
  if (lower.includes('no such file or directory') || lower.includes('cannot open include file') || lower.includes('could not open include file')) {
    return 'A header or file path is missing. Check include paths, generated files, external SDK installation paths and CVI project-relative paths.';
  }
  if (lower.includes('multiple definition') || lower.includes('already defined')) {
    return 'The same symbol is defined in more than one translation unit. Move definitions to one .c file, or make header-local helpers static when appropriate.';
  }
  if (lower.includes('module machine type') || lower.includes('x86') && lower.includes('x64') || lower.includes('architecture')) {
    return 'This looks like an architecture mismatch. Check the active CVI build mode and ensure every .lib/.obj/.dll import library matches x86 or x64.';
  }
  if (lower.includes('build step') || lower.includes('build action')) {
    return 'A CVI pre-build, custom-build or post-build action failed. Check the action command, project working directory, required CALL for batch files, environment variables and the generated cvibuild.<project> build-step files.';
  }
  if (lower.includes('winmain') || lower.includes('main')) {
    return 'The selected target type or subsystem may not match the entry point. Check whether the CVI project is configured as EXE, DLL or static library and verify the expected entry function.';
  }
  return undefined;
}

function isLikelyCviDiagnosticLine(line: string): boolean {
  const lower = line.toLowerCase();
  return lower.includes('error') || lower.includes('warning') || lower.includes('fatal');
}

function coalesceDiagnostics(diagnostics: ParsedCviDiagnostic[]): ParsedCviDiagnostic[] {
  const seen = new Set<string>();
  const result: ParsedCviDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = [diagnostic.severity, diagnostic.file ?? '', diagnostic.line ?? '', diagnostic.column ?? '', diagnostic.code ?? '', diagnostic.message].join('|');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(diagnostic);
  }
  return result;
}

function renderArgument(value: string): string { return /\s/.test(value) ? `"${value}"` : value; }
function replaceExtension(filePath: string, extension: string): string { return path.join(path.dirname(filePath), `${path.basename(filePath, path.extname(filePath))}${extension}`); }


function uniquePaths(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) continue;
    const normalized = path.normalize(trimmed);
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

export function parseCviDefineOptions(value: string): string[] {
  const result: string[] = [];
  const regex = /(?:^|\s)\/D(?:"([^"]+)"|(\S+))/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(value)) !== null) {
    const define = (match[1] ?? match[2] ?? '').trim();
    if (define) result.push(define);
  }
  return result;
}

export function splitWindowsArguments(value: string): string[] {
  const result: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '"') { quoted = !quoted; continue; }
    if (/\s/.test(ch) && !quoted) {
      if (current) { result.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (current) result.push(current);
  return result;
}

function sanitizeFilePart(value: string): string { return value.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'item'; }
function msvcResponseArgument(value: string): string { return /[\s"]/u.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value; }
function sourceContainsToken(filePath: string, expression: RegExp): boolean { try { return expression.test(fs.readFileSync(filePath, 'utf8')); } catch { return false; } }

function defaultExternalBuildSettings(): CviExternalBuildSettings { return { engine: 'cvi', vcvarsallPath: '', buildDirectory: '', additionalCompilerOptions: '', additionalLinkerOptions: '', additionalLibraries: [], useCviExternalSupportFiles: true, debugInVsCode: true }; }
