import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { CviBuildMode, CviWorkspaceProjectRef } from '../model/types';
import { CviParser } from '../model/cviParser';
import { CviInstallation, CviWorkspace } from '../model/types';
import { CviInstallationService } from './cviInstallationService';
import { CviProjectSettingsService } from './cviProjectSettingsService';
import { CviWorkspaceService } from './cviWorkspaceService';
import { CviBreakpointSyncService } from './cviBreakpointSyncService';
import { normalizeRuntimePath } from '../utils/pathUtils';


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

export class CviBuildService {
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

  get buildMode(): CviBuildMode {
    return vscode.workspace.getConfiguration('labwindowsCvi').get<CviBuildMode>('buildMode', 'debug');
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
      { label: '$(play) Build and run', value: 'buildRun', description: 'Build the active target and launch the resulting executable' },
      { label: '$(run) Run without build', value: 'runOnly', description: 'Launch the existing target without invoking compile.exe' },
      { label: '$(debug-alt) Build and run debug', value: 'debug', description: 'Build locally, synchronize breakpoints and run the native CVI debugger' }
    ], { title: 'LabWindows/CVI run action' });
    if (!selected) {
      return;
    }
    if (selected.value === 'runOnly') {
      await this.runWithoutBuild(projectRef);
    } else if (selected.value === 'debug') {
      await vscode.commands.executeCommand('labwindowsCvi.nativeRun');
    } else {
      await this.buildAndRun(projectRef);
    }
  }

  async selectBuildMode(): Promise<void> {
    const selected = await vscode.window.showQuickPick([
      { label: 'Debug x86', value: 'debug' as CviBuildMode, description: 'compile.exe -debug' },
      { label: 'Release x86', value: 'release' as CviBuildMode, description: 'compile.exe -release' },
      { label: 'Debug x64', value: 'debug64' as CviBuildMode, description: 'compile.exe -debug64' },
      { label: 'Release x64', value: 'release64' as CviBuildMode, description: 'compile.exe -release64' }
    ], { title: 'Select the LabWindows/CVI build mode' });
    if (!selected) {
      return;
    }
    await vscode.workspace.getConfiguration('labwindowsCvi').update('buildMode', selected.value, vscode.ConfigurationTarget.Workspace);
    vscode.window.showInformationMessage(`LabWindows/CVI build mode: ${selected.label}.`);
  }

  async build(rebuild = false, projectRef?: CviWorkspaceProjectRef): Promise<boolean> {
    const ref = projectRef ?? this.workspaces.activeProjectRef;
    if (!ref?.exists) {
      vscode.window.showErrorMessage('No existing active CVI project is available for build.');
      return false;
    }
    const installation = await this.requireCompiler();
    if (!installation?.compileExe) {
      return false;
    }

    const report = this.beginOutput(`${rebuild ? 'Rebuild' : 'Build'} ${ref.name}`);
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
        const settings = this.projectSettings.getSettings(item);
        const project = this.workspaces.getProject(item);
        const targetPath = this.parser.getTargetPath(item.absolutePath, this.buildMode);
        const nativeBuildActions = this.projectSettings.hasNativeBuildActions(item);

        this.appendSection('PROJECT / TOOLCHAIN');
        this.output.appendLine(`  Project   : ${item.name}`);
        this.output.appendLine(`  Project   : ${item.absolutePath}`);
        this.output.appendLine(`  Target    : ${targetPath ? normalizeRuntimePath(targetPath) : '<not resolved from .prj>'}`);
        this.output.appendLine(`  Type      : ${project?.targetType ?? '<unknown>'}`);
        this.output.appendLine(`  Compiler  : ${installation.compileExe}`);
        this.output.appendLine(`  Sources   : ${project ? countCompiledSources(project.files) : 0}`);
        this.output.appendLine(`  Actions   : ${nativeBuildActions ? 'native CVI .prj actions executed by compile.exe' : 'extension-managed pre/custom/post actions'}`);
        this.output.appendLine('');

        if (nativeBuildActions) {
          this.output.appendLine(`[CVI] Native CVI build steps detected for ${item.name}; compile.exe will execute the .prj pre-build, custom and post-build actions.`);
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

        const args: string[] = [item.absolutePath, ...this.commonCompilerArguments(rebuild)];
        const result = await this.runCviCompile(installation.compileExe, args, cwd, `${rebuild ? 'Rebuild' : 'Build'} ${item.name}`);
        if (!result.success) {
          failedAt = this.currentReport?.failedAt ?? `${rebuild ? 'Rebuild' : 'Build'} ${item.name}`;
          return false;
        }
        report.projectBuilt += 1;

        if (!nativeBuildActions && !await this.projectSettings.runActions(settings.postBuildActions, `Post-build actions — ${item.name}`, cwd)) {
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

  async clean(projectRef?: CviWorkspaceProjectRef): Promise<void> {
    const ref = projectRef ?? this.workspaces.activeProjectRef;
    if (!ref?.exists) {
      vscode.window.showErrorMessage('No existing active CVI project is available to clean.');
      return;
    }
    const report = this.beginOutput(`Clean ${ref.name}`);
    let success = true;
    try {
      const project = this.workspaces.getProject(ref);
      const target = this.parser.getTargetPath(ref.absolutePath, this.buildMode);
      const candidates = new Set<string>();
      if (target) {
        candidates.add(target);
        candidates.add(replaceExtension(target, '.cdb'));
        candidates.add(replaceExtension(target, '.pdb'));
        if (project?.targetType === 'Dynamic Link Library') {
          candidates.add(replaceExtension(target, '.lib'));
        }
      }

      this.appendSection('CLEAN GENERATED TARGET');
      this.output.appendLine(`  Project   : ${ref.name}`);
      this.output.appendLine(`  Target    : ${target ? normalizeRuntimePath(target) : '<not resolved from .prj>'}`);
      this.output.appendLine(`  Type      : ${project?.targetType ?? '<unknown>'}`);
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

    const report = this.beginOutput(`Compile ${path.basename(filePath)}`);
    let success = false;
    try {
      this.appendSection('SOURCE / TOOLCHAIN');
      this.output.appendLine(`  Source    : ${filePath}`);
      this.output.appendLine(`  Project   : ${ref.absolutePath}`);
      this.output.appendLine(`  Compiler  : ${installation.compileExe}`);
      this.output.appendLine('');

      const args = [filePath, ref.absolutePath, ...this.commonCompilerArguments(false)];
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

  async run(projectRef?: CviWorkspaceProjectRef): Promise<void> {
    await this.buildAndRun(projectRef);
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
    const run = this.projectSettings.getSettings(ref).run;
    const targetPath = this.parser.getTargetPath(ref.absolutePath, this.buildMode);
    const useExternalHost = project?.targetType === 'Dynamic Link Library' && run.externalProcessPath.trim().length > 0;
    const rawExecutablePath = useExternalHost ? run.externalProcessPath.trim() : targetPath;
    if (!rawExecutablePath) {
      vscode.window.showErrorMessage(`The output target for ${ref.name} could not be resolved from the CVI project.`);
      return;
    }
    const executablePath = normalizeRuntimePath(rawExecutablePath);
    if (executablePath !== rawExecutablePath) {
      this.output.appendLine(`[CVI] Normalized runtime path: ${rawExecutablePath} -> ${executablePath}`);
    }
    if (path.extname(executablePath).toLowerCase() !== '.exe') {
      vscode.window.showErrorMessage(`The selected target is ${path.basename(executablePath)}, not an executable. Configure an external executable for DLL debugging in CVI Project Build Settings.`);
      return;
    }
    if (!fs.existsSync(executablePath)) {
      if (useExternalHost) {
        vscode.window.showErrorMessage(`The external executable configured for DLL debugging does not exist: ${executablePath}`);
        this.output.appendLine(`[CVI] DLL external executable not found: ${executablePath}`);
      } else {
        vscode.window.showErrorMessage(`The executable does not exist: ${executablePath}. Use Build and Run to create the target before launching it.`);
        this.output.appendLine(`[CVI] Executable not found: ${executablePath}`);
      }
      return;
    }
    const fallbackArgs = vscode.workspace.getConfiguration('labwindowsCvi').get<string[]>('runArguments', []);
    const args = run.arguments.trim() ? this.projectSettings.parseArguments(run.arguments) : fallbackArgs;
    const configuredCwd = run.workingDirectory.trim();
    const cwd = configuredCwd ? normalizeRuntimePath(configuredCwd) : path.dirname(executablePath);
    if (configuredCwd && cwd !== configuredCwd) {
      this.output.appendLine(`[CVI] Normalized working directory: ${configuredCwd} -> ${cwd}`);
    }
    if (!fs.existsSync(cwd)) {
      vscode.window.showErrorMessage(`The configured working directory does not exist: ${cwd}`);
      return;
    }
    const child = spawn(executablePath, args, { cwd, env: this.projectSettings.parseEnvironment(run.environmentOptions), detached: true, shell: false, stdio: 'ignore' });
    child.unref();
    this.output.appendLine(`[CVI] Started ${executablePath} ${args.map(renderArgument).join(' ')}`);
  }

  async debugInCvi(projectRef?: CviWorkspaceProjectRef): Promise<void> {
    const ref = projectRef ?? this.workspaces.activeProjectRef;
    if (!ref?.exists) {
      vscode.window.showErrorMessage('No existing CVI project is available for debugging.');
      return;
    }
    if (this.buildMode === 'release' || this.buildMode === 'release64') {
      const debugMode: CviBuildMode = this.buildMode === 'release64' ? 'debug64' : 'debug';
      const answer = await vscode.window.showWarningMessage(`The active build mode is ${this.buildMode}. Switch to ${debugMode}, build the project and open the native CVI debugger?`, 'Switch, build and open', 'Cancel');
      if (answer !== 'Switch, build and open') {
        return;
      }
      await vscode.workspace.getConfiguration('labwindowsCvi').update('buildMode', debugMode, vscode.ConfigurationTarget.Workspace);
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

  private beginOutput(label: string): CviBuildReport {
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
    this.output.appendLine(`  Mode      : ${this.buildMode}`);
    this.output.appendLine(`  Started   : ${formatDateTime(report.startedAt)}`);
    this.output.appendLine(`  Log detail: ${detail}`);
    this.output.appendLine('');
    this.output.appendLine('  Full compile.exe commands, CVI log files and raw tool output are available in:');
    this.output.appendLine('  Output -> LabWindows/CVI - Build Trace');
    this.output.appendLine('');

    this.traceOutput.appendLine('='.repeat(80));
    this.traceOutput.appendLine(` CVI BUILD TRACE  |  ${label}`);
    this.traceOutput.appendLine('='.repeat(80));
    this.traceOutput.appendLine(`Mode    : ${this.buildMode}`);
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

  private commonCompilerArguments(rebuild: boolean): string[] {
    const config = vscode.workspace.getConfiguration('labwindowsCvi');
    const customConfig = config.get<string>('customBuildConfiguration', '').trim();
    const extraArguments = config.get<string[]>('extraCompilerArguments', []);
    const args: string[] = [`-${this.buildMode}`];
    if (rebuild) args.push('-rebuild');
    if (customConfig) args.push(`-config=${customConfig}`);
    args.push(...extraArguments);
    return args;
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
      const finish = (code: number | null, launchError?: Error): void => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        drainLog();
        const durationMs = Date.now() - started;
        const combinedOutput = [stdout, stderr, logText].filter(Boolean).join('\n');
        const diagnostics = launchError
          ? [{ severity: 'error' as const, message: `Unable to start ${compileExe}: ${launchError.message}`, toolLabel: label, rawLine: launchError.message, hint: 'Check that the LabWindows/CVI installation path is valid and that compile.exe can be launched from VS Code.' }]
          : parseCviDiagnostics(combinedOutput, label);
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
      child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); this.traceOutput.append(data.toString()); });
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); this.traceOutput.append(data.toString()); });
      child.on('error', (error) => finish(null, error));
      child.on('close', (code) => finish(code));
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

    this.traceOutput.appendLine('');
    this.traceOutput.appendLine('stdout:');
    this.traceOutput.appendLine(result.stdout.trimEnd() || '  <empty>');
    this.traceOutput.appendLine('');
    this.traceOutput.appendLine('stderr:');
    this.traceOutput.appendLine(result.stderr.trimEnd() || '  <empty>');
    this.traceOutput.appendLine('');
    this.traceOutput.appendLine('CVI log file:');
    this.traceOutput.appendLine(`  ${result.logFile}`);
    this.traceOutput.appendLine('');
    this.traceOutput.appendLine('CVI log content captured by extension:');
    this.traceOutput.appendLine(result.logText.trimEnd() || '  <empty>');
    this.traceOutput.appendLine('');
    this.traceOutput.appendLine(`Exit code: ${String(result.code)}`);
    this.traceOutput.appendLine(`Duration : ${formatDuration(result.durationMs)}`);
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

function parseCviDiagnostics(output: string, toolLabel: string): ParsedCviDiagnostic[] {
  const diagnostics: ParsedCviDiagnostic[] = [];
  const lines = output.split(/\r?\n/);
  const gccLocation = /^(.+?):(\d+):(\d+):\s*(fatal error|error|warning|note):\s*(.+)$/i;
  const gccLocationNoColumn = /^(.+?):(\d+):\s*(fatal error|error|warning|note):\s*(.+)$/i;
  const msvcLocation = /^(.+?)\((\d+)(?:,(\d+))?\):\s*(fatal error|error|warning)\s*([A-Z]+\d+)?\s*:\s*(.+)$/i;
  const cviQuotedLocation = /^"?([^"\r\n]+?\.(?:c|h|uir|prj))"?\s*,?\s*line\s+(\d+)(?:\s*,?\s*column\s+(\d+))?\s*[:\-]\s*(fatal error|error|warning|note)\s*[:\-]?\s*(.+)$/i;
  const cviLocation = /^(.+?\.(?:c|h|uir|prj))\s*\((\d+)(?:\s*,\s*(\d+))?\)\s*[:\-]\s*(fatal error|error|warning|note)\s*[:\-]?\s*(.+)$/i;
  const cviCodeFirst = /^(fatal error|error|warning|note)\s*(?:([A-Z]+\d+|\-?\d+)\s*)?[:\-]\s*(.+)$/i;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    let match = line.match(gccLocation);
    if (match) {
      const message = match[5].trim();
      diagnostics.push({
        severity: normalizeSeverity(match[4]),
        file: match[1],
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
        file: match[1],
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
        file: match[1],
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
    match = line.match(cviQuotedLocation) ?? line.match(cviLocation);
    if (match) {
      const message = match[5].trim();
      diagnostics.push({
        severity: normalizeSeverity(match[4]),
        file: match[1],
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
