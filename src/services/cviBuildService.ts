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

export class CviBuildService {
  constructor(
    private readonly parser: CviParser,
    private readonly workspaces: CviWorkspaceService,
    private readonly installations: CviInstallationService,
    private readonly projectSettings: CviProjectSettingsService,
    private readonly breakpoints: CviBreakpointSyncService,
    private readonly output: vscode.OutputChannel
  ) {}

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

    this.beginOutput(`${rebuild ? 'Rebuild' : 'Build'} ${ref.name}`);
    const order = this.projectSettings.getBuildOrder(ref);
    this.output.appendLine(`[CVI] Build order: ${order.map((item) => item.name).join(' -> ')}`);
    this.output.appendLine('');
    for (const item of order) {
      const cwd = path.dirname(item.absolutePath);
      const settings = this.projectSettings.getSettings(item);
      const nativeBuildActions = this.projectSettings.hasNativeBuildActions(item);
      if (nativeBuildActions) {
        this.output.appendLine(`[CVI] Native CVI build steps detected for ${item.name}; compile.exe will execute the .prj pre-build, custom and post-build actions.`);
      } else {
        if (!await this.projectSettings.runActions(settings.preBuildActions, `Pre-build actions — ${item.name}`, cwd)) {
          return false;
        }
        if (!await this.projectSettings.runActions(settings.customBuildActions, `Custom build actions — ${item.name}`, cwd)) {
          return false;
        }
      }
      const args: string[] = [item.absolutePath, ...this.commonCompilerArguments(rebuild)];
      const success = await this.spawnCompile(installation.compileExe, args, cwd, `${rebuild ? 'Rebuild' : 'Build'} ${item.name}`);
      if (!success) {
        return false;
      }
      if (!nativeBuildActions && !await this.projectSettings.runActions(settings.postBuildActions, `Post-build actions — ${item.name}`, cwd)) {
        return false;
      }
    }
    vscode.window.showInformationMessage(`${rebuild ? 'Rebuild' : 'Build'} completed successfully.`);
    return true;
  }

  async clean(projectRef?: CviWorkspaceProjectRef): Promise<void> {
    const ref = projectRef ?? this.workspaces.activeProjectRef;
    if (!ref?.exists) {
      vscode.window.showErrorMessage('No existing active CVI project is available to clean.');
      return;
    }
    this.beginOutput(`Clean ${ref.name}`);
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
    let removed = 0;
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) {
        continue;
      }
      try {
        fs.rmSync(candidate, { force: true });
        this.output.appendLine(`[CVI] Deleted: ${candidate}`);
        removed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.output.appendLine(`[CVI] Unable to delete ${candidate}: ${message}`);
      }
    }
    if (removed === 0) {
      this.output.appendLine('[CVI] No generated target file was found. Source files and referenced libraries were not modified.');
    }
    vscode.window.showInformationMessage(`Clean completed for ${ref.name}: ${removed} generated file(s) removed.`);
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
    this.beginOutput(`Compile ${path.basename(filePath)}`);
    const args = [filePath, ref.absolutePath, ...this.commonCompilerArguments(false)];
    const success = await this.spawnCompile(installation.compileExe, args, path.dirname(ref.absolutePath), `Compile ${path.basename(filePath)}`);
    if (success) {
      vscode.window.showInformationMessage(`${path.basename(filePath)} compiled successfully.`);
    }
    return success;
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

  private beginOutput(label: string): void {
    this.output.clear();
    this.output.show(true);
    this.output.appendLine(`[CVI] ${label} started`);
    this.output.appendLine(`[CVI] Build mode: ${this.buildMode}`);
    this.output.appendLine('');
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

  private async spawnCompile(compileExe: string, args: string[], cwd: string, label: string): Promise<boolean> {
    const logFile = this.createBuildLogPath(cwd, label);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    try { fs.rmSync(logFile, { force: true }); } catch { /* ignored */ }
    const allArgs = [...args, '-log', logFile];
    this.output.appendLine(`[CVI] ${label}`);
    this.output.appendLine(`[CVI] Compiler: ${compileExe}`);
    this.output.appendLine(`[CVI] Arguments: ${allArgs.map(renderArgument).join(' ')}`);
    this.output.appendLine(`[CVI] Complete build log: ${logFile}`);
    this.output.appendLine('');

    return await new Promise<boolean>((resolve) => {
      let logOffset = 0;
      let closed = false;
      const drainLog = (): void => {
        if (!fs.existsSync(logFile)) return;
        try {
          const data = fs.readFileSync(logFile);
          if (data.length > logOffset) {
            this.output.append(data.subarray(logOffset).toString());
            logOffset = data.length;
          }
        } catch { /* log file may be temporarily locked by CVI */ }
      };
      const timer = setInterval(drainLog, 150);
      const finish = (success: boolean): void => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        drainLog();
        resolve(success);
      };
      const child = spawn(compileExe, allArgs, { cwd, windowsHide: true, shell: false });
      child.stdout.on('data', (data: Buffer) => this.output.append(data.toString()));
      child.stderr.on('data', (data: Buffer) => this.output.append(data.toString()));
      child.on('error', (error) => {
        this.output.appendLine(`\n[CVI] Unable to start compile.exe: ${error.message}`);
        vscode.window.showErrorMessage(`Unable to start LabWindows/CVI compiler: ${error.message}`);
        finish(false);
      });
      child.on('close', (code) => {
        this.output.appendLine('');
        this.output.appendLine(`[CVI] compile.exe exited with code ${String(code)}.`);
        if (code !== 0) {
          vscode.window.showErrorMessage(`${label} failed. Open the LabWindows/CVI output channel for details.`);
        }
        finish(code === 0);
      });
    });
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

function renderArgument(value: string): string { return /\s/.test(value) ? `"${value}"` : value; }
function replaceExtension(filePath: string, extension: string): string { return path.join(path.dirname(filePath), `${path.basename(filePath, path.extname(filePath))}${extension}`); }
