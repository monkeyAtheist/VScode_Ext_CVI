import * as fs from 'fs';
import * as path from 'path';
import { ChildProcessWithoutNullStreams, execFile, spawn } from 'child_process';
import * as vscode from 'vscode';
import { CviBreakpointSyncService } from './cviBreakpointSyncService';
import { CviInstallationService } from './cviInstallationService';
import { CviWorkspaceService } from './cviWorkspaceService';

const COMMANDS = {
  build: 'Build Project',
  run: 'Run Project',
  pause: 'Suspend Execution',
  continueExecution: 'Continue Execution',
  stop: 'Terminate Execution',
  state: 'Get CVI State'
} as const;

interface BridgeAttempt {
  mode: string;
  service?: string;
  topic?: string;
  item?: string;
  ok: boolean;
  stage?: string;
  ddeError?: number;
  ddeErrorName?: string;
  error: string;
}

interface BridgeBootstrap {
  assemblyPath: string;
  loadedFromCache: boolean;
  compiled: boolean;
  warnings?: string[];
}

interface BridgePayload {
  ok: boolean;
  transport?: string;
  command: string;
  argument: string;
  raw: string;
  error: string;
  mode?: string;
  attempts?: BridgeAttempt[];
  bootstrap?: BridgeBootstrap;
  progId?: string;
  connectionMode?: string;
  method?: string;
  fallbackFrom?: BridgePayload;
}

interface ActiveXCandidate {
  kind?: string;
  registryView?: string;
  clsid: string;
  description: string;
  progId: string;
  versionIndependentProgId: string;
  localServer32: string;
  inprocServer32: string;
  registryPath: string;
}

interface ActiveXDiscoveryPayload {
  ok: boolean;
  transport: string;
  candidates: ActiveXCandidate[];
  scannedRoots?: string[];
  warnings?: string[];
  error: string;
}

interface DdeSessionPayload extends BridgePayload {
  id?: string;
  event?: 'ready' | 'response';
}

interface DdeSessionPending {
  resolve: (payload: BridgePayload) => void;
  timer: NodeJS.Timeout;
}

interface DdeSessionInvokeOptions {
  timeoutMs?: number;
  closeOnTimeout?: boolean;
}

export interface CviNativeCommandOptions {
  silent?: boolean;
  background?: boolean;
}

export interface CviNativeExecutionTransition {
  previous: CviNativeState['projectExecution'];
  current: CviNativeState['projectExecution'];
  origin: 'native' | 'cached' | 'poll';
}

interface DdeSessionHandle {
  process: ChildProcessWithoutNullStreams;
  buffer: string;
  stderr: string;
  pending: Map<string, DdeSessionPending>;
  readyPromise: Promise<BridgePayload>;
  resolveReady: (payload: BridgePayload) => void;
  readySettled: boolean;
  workspacePath: string;
}

export interface CviNativeState {
  raw: string;
  commandStatus: number;
  projectCompiledAndLinked: boolean;
  projectExecution: 'idle' | 'running' | 'suspended' | 'unknown';
  interactiveWindowCompiledAndLinked: boolean;
  interactiveWindowExecution: 'idle' | 'running' | 'suspended' | 'unknown';
  waitingForUserResponse: boolean;
  queuedKeystrokes: number;
}

export interface CviNativeDebugSnapshot {
  sessionConnected: boolean;
  serverAvailable?: boolean;
  execution: CviNativeState['projectExecution'];
  projectCompiledAndLinked?: boolean;
  waitingForUserResponse?: boolean;
  stateSource: 'native' | 'cached' | 'unknown';
  transport: 'dde' | 'auto' | 'activex';
  workspacePath?: string;
  projectPath?: string;
  projectName?: string;
  lastCommand: string;
  lastResult: string;
  updatedAt?: number;
}

const CVI_COMMAND_ERRORS = [
  'No error',
  'Command name missing',
  'Unknown command name',
  'Path name missing',
  'Invalid path name syntax',
  'Path name is not absolute',
  'Path name is neither absolute nor a simple file name',
  'Path name is not in the project',
  'File does not exist',
  'File is not loaded',
  'A user program is already running',
  'Execution is already suspended',
  'No program is running',
  'No execution is suspended',
  'Execution is neither running nor suspended',
  'File cannot be excluded',
  'File is not an instrument',
  'File is not a source or text file',
  'File is not a C source file',
  'Window must remain open',
  'Line is too long',
  'Out of memory',
  'CVI is waiting for a user response',
  'File is not a function-panel file',
  'No function-panel file is identified',
  'No function-panel function is identified',
  'Function name missing',
  'Function name does not exist in the function-panel file',
  'Parameter index missing',
  'Invalid parameter index',
  'Unable to read function-panel file',
  'New instrument name missing',
  'New function name missing',
  'A miscellaneous error was reported in CVI',
  'Invalid integer value',
  'Invalid project-file index',
  'Project is untitled',
  'File is not a source file',
  'File is not a UIR file',
  'File is not a project file',
  'Keystroke queue overflow',
  'Invalid keystroke interval',
  'Unable to create a new project',
  'Unable to open the project',
  'File cannot be included'
];

export class CviNativeCommandService implements vscode.Disposable {
  private readonly bridgeScript: string;
  private readonly activeXCommandScript: string;
  private readonly activeXDiscoveryScript: string;
  private readonly backgroundStartScript: string;
  private readonly windowControlScript: string;

  private ddeSession?: DdeSessionHandle;
  private ddeSessionSequence = 0;
  private cachedProjectExecution: CviNativeState['projectExecution'] = 'unknown';
  private projectCompiledAndLinked?: boolean;
  private serverAvailable?: boolean;
  private waitingForUserResponse?: boolean;
  private stateSource: CviNativeDebugSnapshot['stateSource'] = 'unknown';
  private lastCommand = 'None';
  private lastResult = 'No native CVI command has been sent yet.';
  private lastUpdatedAt?: number;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly executionTransitionEmitter = new vscode.EventEmitter<CviNativeExecutionTransition>();
  readonly onDidExecutionTransition = this.executionTransitionEmitter.event;
  private debugAdapterMonitorUsers = 0;
  private debugAdapterPollTimer?: NodeJS.Timeout;
  private debugAdapterPollInFlight = false;
  private debugAdapterPollFailures = 0;
  private nativeCompletionMonitor?: NodeJS.Timeout;
  private nativeCompletionMonitorInFlight = false;

  constructor(
    context: vscode.ExtensionContext,
    private readonly workspaces: CviWorkspaceService,
    private readonly installations: CviInstallationService,
    private readonly breakpoints: CviBreakpointSyncService,
    private readonly output: vscode.OutputChannel
  ) {
    this.bridgeScript = context.asAbsolutePath(path.join('native', 'cvi-dde-command.ps1'));
    this.activeXCommandScript = context.asAbsolutePath(path.join('native', 'cvi-activex-command.ps1'));
    this.activeXDiscoveryScript = context.asAbsolutePath(path.join('native', 'cvi-activex-discovery.ps1'));
    this.backgroundStartScript = context.asAbsolutePath(path.join('native', 'cvi-start-background.ps1'));
    this.windowControlScript = context.asAbsolutePath(path.join('native', 'cvi-window-control.ps1'));
  }

  dispose(): void {
    this.stopDebugAdapterMonitoring();
    this.stopNativeCompletionMonitor();
    this.closeDdeSession('extension disposed');
    this.executionTransitionEmitter.dispose();
    this.changeEmitter.dispose();
  }

  getDebugSnapshot(): CviNativeDebugSnapshot {
    const ref = this.workspaces.activeProjectRef;
    return {
      sessionConnected: Boolean(this.ddeSession && !this.ddeSession.process.killed),
      serverAvailable: this.serverAvailable,
      execution: this.cachedProjectExecution,
      projectCompiledAndLinked: this.projectCompiledAndLinked,
      waitingForUserResponse: this.waitingForUserResponse,
      stateSource: this.stateSource,
      transport: this.nativeCommandTransport,
      workspacePath: this.workspaces.currentWorkspace?.path,
      projectPath: ref?.absolutePath,
      projectName: ref?.name,
      lastCommand: this.lastCommand,
      lastResult: this.lastResult,
      updatedAt: this.lastUpdatedAt
    };
  }

  async refreshDebugSnapshot(): Promise<void> {
    if (this.ddeSession && (this.cachedProjectExecution === 'running' || this.cachedProjectExecution === 'suspended')) {
      this.publishChange();
      return;
    }
    const state = await this.getDdeState(true);
    if (!state) {
      this.serverAvailable = false;
      this.projectCompiledAndLinked = undefined;
      this.waitingForUserResponse = undefined;
      this.cachedProjectExecution = 'unknown';
      this.stateSource = 'unknown';
      this.lastUpdatedAt = Date.now();
      this.publishChange();
    }
  }

  async chooseAction(): Promise<void> {
    const selected = await vscode.window.showQuickPick([
      { label: '$(play) Build & Run Debug', action: () => vscode.commands.executeCommand('labwindowsCvi.nativeRun') },
      { label: '$(debug-pause) Pause', action: () => this.pause() },
      { label: '$(debug-continue) Continue', action: () => this.continueExecution() },
      { label: '$(debug-stop) Stop', action: () => this.stop() },
      { label: '$(pulse) State', action: () => this.showState() },
      { label: '$(tools) Diagnose bridge', action: () => this.diagnose() }
    ], { title: 'LabWindows/CVI native debug controls', placeHolder: 'Choose a command sent to the native CVI environment.' });
    if (selected) {
      await selected.action();
    }
  }

  async build(options: CviNativeCommandOptions = {}): Promise<boolean> {
    if (!await this.ensureServer(true, options.background === true)) return false;
    const state = await this.getState(true, false);
    if (state && state.projectExecution !== 'idle') {
      if (!options.silent) vscode.window.showWarningMessage(`Cannot build the active CVI project while execution is ${state.projectExecution}. Stop the current execution first.`);
      return false;
    }
    if (await this.executeAction(COMMANDS.build, 'Native CVI build command accepted.', false, options.silent === true)) {
      this.projectCompiledAndLinked = true;
      this.setCachedExecution('idle', 'cached');
      return true;
    }
    return false;
  }

  async run(options: CviNativeCommandOptions = {}): Promise<boolean> {
    const ref = this.workspaces.activeProjectRef;
    if (!ref?.exists) {
      if (!options.silent) vscode.window.showErrorMessage('No existing CVI project is available for native debugging.');
      return false;
    }
    const workspace = this.workspaces.currentWorkspace;
    const shouldSynchronize = vscode.workspace.getConfiguration('labwindowsCvi').get<boolean>('synchronizeBreakpointsBeforeNativeRun', true);
    if (shouldSynchronize && workspace && path.extname(workspace.path).toLowerCase() === '.cws') {
      await this.breakpoints.synchronize(ref, false);
    }
    if (!await this.ensureServer(true, options.background === true)) return false;
    const state = await this.getState(true, false);
    if (state && state.projectExecution !== 'idle') {
      if (!options.silent) vscode.window.showWarningMessage(`The active CVI project is already ${state.projectExecution}. Stop or continue the current execution before starting a new run.`);
      return false;
    }
    if (!await this.ensureDdeSession()) {
      if (!options.silent) vscode.window.showErrorMessage('Unable to establish the persistent LabWindows/CVI DDE debug session before launching the project.');
      return false;
    }
    if (await this.executeAction(COMMANDS.run, 'Native CVI execution started.', true, options.silent === true)) {
      this.projectCompiledAndLinked = true;
      this.setCachedExecution('running', 'cached');
      this.startNativeCompletionMonitor();
      if (options.background === true) this.keepNativeIdeInBackground();
      return true;
    }
    return false;
  }

  async pause(options: CviNativeCommandOptions = {}): Promise<boolean> {
    const accepted = await this.executeDdeSessionControl(COMMANDS.pause, 'Native CVI execution suspended.', 'suspended', options.silent === true);
    if (accepted && options.background === true) this.keepNativeIdeInBackground();
    return accepted;
  }

  async continueExecution(options: CviNativeCommandOptions = {}): Promise<boolean> {
    const accepted = await this.executeDdeSessionControl(COMMANDS.continueExecution, 'Native CVI execution resumed.', 'running', options.silent === true);
    if (accepted && options.background === true) this.keepNativeIdeInBackground();
    return accepted;
  }

  async stop(options: CviNativeCommandOptions = {}): Promise<boolean> {
    const accepted = await this.executeDdeSessionControl(COMMANDS.stop, 'Native CVI execution terminated.', 'idle', options.silent === true);
    if (accepted) this.stopNativeCompletionMonitor();
    if (accepted && options.background === true) this.keepNativeIdeInBackground();
    return accepted;
  }

  startDebugAdapterMonitoring(): vscode.Disposable {
    this.debugAdapterMonitorUsers += 1;
    this.scheduleDebugAdapterPoll(250);
    return new vscode.Disposable(() => {
      this.debugAdapterMonitorUsers = Math.max(0, this.debugAdapterMonitorUsers - 1);
      if (this.debugAdapterMonitorUsers === 0) this.stopDebugAdapterMonitoring();
    });
  }

  async endDebugAdapterSession(terminateExecution = false): Promise<void> {
    if (terminateExecution && this.ddeSession && this.cachedProjectExecution !== 'idle') {
      await this.stop({ silent: true, background: true });
    }
    this.stopDebugAdapterMonitoring();
    this.closeDdeSession('VS Code debug session ended');
    if (this.cachedProjectExecution !== 'idle') this.setCachedExecution('idle', 'cached');
  }

  async showState(): Promise<void> {
    if (this.ddeSession && (this.cachedProjectExecution === 'running' || this.cachedProjectExecution === 'suspended')) {
      vscode.window.showInformationMessage(`Native CVI debug session: execution ${this.cachedProjectExecution} (cached while the project is active).`);
      return;
    }
    const state = await this.getState(true);
    if (!state) return;
    this.rememberState(state);
    vscode.window.showInformationMessage(this.renderState(state));
  }

  async diagnose(): Promise<void> {
    this.output.show(true);
    this.output.appendLine('[CVI] Native command bridge diagnostic');
    this.output.appendLine(`[CVI] Platform: ${process.platform}`);
    this.output.appendLine(`[CVI] ActiveX command script: ${this.activeXCommandScript}`);
    this.output.appendLine(`[CVI] ActiveX command script exists: ${fs.existsSync(this.activeXCommandScript)}`);
    this.output.appendLine(`[CVI] DDE fallback script: ${this.bridgeScript}`);
    this.output.appendLine(`[CVI] DDE fallback script exists: ${fs.existsSync(this.bridgeScript)}`);
    this.output.appendLine(`[CVI] ActiveX discovery script: ${this.activeXDiscoveryScript}`);
    this.output.appendLine(`[CVI] ActiveX discovery script exists: ${fs.existsSync(this.activeXDiscoveryScript)}`);
    this.output.appendLine(`[CVI] PowerShell executable: ${this.powershellExecutable}`);
    this.output.appendLine(`[CVI] Native transport strategy: ${this.nativeCommandTransport}`);
    this.output.appendLine(`[CVI] Workspace: ${this.workspaces.currentWorkspace?.path ?? '<none>'}`);
    this.output.appendLine(`[CVI] Active project: ${this.workspaces.activeProjectRef?.absolutePath ?? '<none>'}`);
    this.output.appendLine(`[CVI] Persistent DDE debug session: ${this.ddeSession ? `connected · cached execution ${this.cachedProjectExecution}` : 'not connected'}`);
    if (process.platform !== 'win32') {
      this.output.appendLine('[CVI] The native ActiveX/DDE bridge is available only on Windows.');
      vscode.window.showWarningMessage('The native LabWindows/CVI command bridge is available only on Windows.');
      return;
    }
    if (!fs.existsSync(this.activeXCommandScript) || !fs.existsSync(this.bridgeScript)) {
      vscode.window.showErrorMessage('One or more native LabWindows/CVI command bridge scripts are missing from the installed extension.');
      return;
    }
    if (this.ddeSession && (this.cachedProjectExecution === 'running' || this.cachedProjectExecution === 'suspended')) {
      vscode.window.showInformationMessage(`Persistent LabWindows/CVI DDE debug session is operational. Execution ${this.cachedProjectExecution} (cached).`);
      return;
    }
    const response = await this.invoke(COMMANDS.state, '', true);
    this.logResponse(response);
    if (!response.ok) {
      const discovery = await this.discoverActiveX();
      this.logActiveXDiscovery(discovery);
      const suffix = discovery.candidates.length > 0
        ? ` ActiveX registry candidates were found and listed in the LabWindows/CVI output channel.`
        : ` No LabWindows/CVI ActiveX registry candidate was detected automatically.`;
      vscode.window.showWarningMessage(`Unable to connect to the native LabWindows/CVI command server. ${this.formatBridgeError(response)}${suffix}`);
      return;
    }
    const state = this.parseState(response.raw);
    if (!state) {
      vscode.window.showWarningMessage(`LabWindows/CVI responded, but its state could not be decoded: ${response.raw}`);
      return;
    }
    this.rememberState(state);
    this.output.appendLine(`[CVI] ${this.renderState(state)}`);
    vscode.window.showInformationMessage(`Native LabWindows/CVI command bridge is operational. ${this.renderState(state)}`);
  }

  async getState(silent = false, createActiveXIfMissing = true): Promise<CviNativeState | undefined> {
    if (process.platform !== 'win32') {
      if (!silent) vscode.window.showWarningMessage('The native LabWindows/CVI command bridge is available only on Windows.');
      return undefined;
    }
    const response = await this.invoke(COMMANDS.state, '', createActiveXIfMissing);
    this.logResponse(response);
    if (!response.ok) {
      if (!silent) vscode.window.showWarningMessage(`Unable to connect to the native LabWindows/CVI command server. ${this.formatBridgeError(response)}`);
      return undefined;
    }
    const state = this.parseState(response.raw);
    if (!state) {
      if (!silent) vscode.window.showWarningMessage(`LabWindows/CVI responded, but its state could not be decoded: ${response.raw}`);
      return undefined;
    }
    this.rememberState(state);
    return state;
  }

  private async executeAction(command: string, acceptedMessage: string, usePersistentDdeSession = false, silent = false): Promise<boolean> {
    this.markAction(command, 'Sending command to native CVI…');
    const response = usePersistentDdeSession ? await this.invokeDdeSession(command, '') : await this.invoke(command, '', true);
    this.logResponse(response);
    if (!response.ok) {
      const details = this.formatBridgeError(response);
      this.markAction(command, `Failed: ${details}`);
      if (!silent) vscode.window.showErrorMessage(`Unable to send "${command}" to LabWindows/CVI. ${details}`);
      return false;
    }
    const rawCommandStatus = this.parseCommandStatus(response.raw);
    const commandStatus = this.normalizeCommandStatus(rawCommandStatus);
    // cmdsrvr.h specifies 0 as the only accepted status for action commands.
    // Negative values are CVI command errors. A positive value is unexpected,
    // but its absolute value often still maps to the same CVI error table; keep
    // it visible and never advance the cached debugger state silently.
    if (!Number.isFinite(commandStatus) || commandStatus !== 0) {
      const statusDetails = rawCommandStatus === commandStatus
        ? `${commandStatus}`
        : `${rawCommandStatus}; decoded CVI status ${commandStatus}`;
      const details = `${this.describeCommandStatus(commandStatus)} (${statusDetails})`;
      this.markAction(command, `Rejected: ${details}`);
      if (!silent) vscode.window.showErrorMessage(`LabWindows/CVI rejected "${command}": ${details}.`);
      return false;
    }
    this.markAction(command, 'Accepted by native CVI.');
    if (!silent) vscode.window.showInformationMessage(acceptedMessage);
    return true;
  }

  private async executeDdeSessionControl(command: string, acceptedMessage: string, nextState: CviNativeState['projectExecution'], silent = false): Promise<boolean> {
    if (!this.ddeSession) {
      this.markAction(command, 'Skipped: no persistent native CVI debug session is connected.');
      if (!silent) vscode.window.showWarningMessage('No persistent native CVI debug session is available. Start the project with “Run Project in Native CVI Debugger” first.');
      return false;
    }
    if (await this.executeAction(command, acceptedMessage, true, silent)) {
      this.setCachedExecution(nextState, 'cached');
      return true;
    }
    return false;
  }

  private async ensureServer(autoOpen: boolean, background = false): Promise<boolean> {
    if (process.platform !== 'win32') {
      vscode.window.showWarningMessage('The native LabWindows/CVI command bridge is available only on Windows.');
      return false;
    }
    if (await this.getDdeState(true)) {
      return true;
    }
    if (!autoOpen) {
      vscode.window.showWarningMessage('LabWindows/CVI is not exposing its native DDE command server. Open the workspace in CVI first.');
      return false;
    }
    const workspace = this.workspaces.currentWorkspace;
    const ref = this.workspaces.activeProjectRef;
    const openPath = workspace?.path ?? ref?.absolutePath;
    if (!openPath || !fs.existsSync(openPath)) {
      vscode.window.showErrorMessage('No existing CVI workspace or project is available to open.');
      return false;
    }
    let installation = this.installations.getActiveInstallation(workspace?.cviDir);
    if (!installation?.ideExe) {
      installation = await this.installations.selectInstallation(workspace?.cviDir);
    }
    if (!installation?.ideExe) {
      vscode.window.showErrorMessage('LabWindows/CVI IDE executable not found. Select the correct installation directory.');
      return false;
    }
    await this.startNativeIde(installation.ideExe, openPath, background);
    const startupTimeout = Math.max(1000, vscode.workspace.getConfiguration('labwindowsCvi').get<number>('nativeCommandStartupTimeoutMs', 10000));
    const deadline = Date.now() + startupTimeout;
    while (Date.now() < deadline) {
      await delay(400);
      if (await this.getDdeState(true)) {
        await this.waitAfterNativeIdeStartup();
        return true;
      }
    }
    vscode.window.showWarningMessage('LabWindows/CVI was opened, but its native DDE command server did not become available before the startup timeout expired.');
    return false;
  }

  private async getDdeState(silent = false): Promise<CviNativeState | undefined> {
    const response = await this.invokeDde(COMMANDS.state, '');
    // During IDE startup CVI can temporarily expose the DDE conversation while
    // still rejecting commands with DMLERR_BUSY. Keep polling silently in that
    // case so the output channel reports the stable result instead of expected
    // transient startup noise.
    if (!silent || response.ok) {
      this.logResponse(response);
    }
    if (!response.ok) {
      if (!silent) vscode.window.showWarningMessage(`Unable to connect to the native LabWindows/CVI DDE command server. ${this.formatBridgeError(response)}`);
      return undefined;
    }
    const state = this.parseState(response.raw);
    if (!state && !silent) {
      vscode.window.showWarningMessage(`LabWindows/CVI responded, but its state could not be decoded: ${response.raw}`);
    }
    if (state) this.rememberState(state);
    return state;
  }

  private async invoke(command: string, argument = '', createActiveXIfMissing = false): Promise<BridgePayload> {
    const strategy = this.nativeCommandTransport;
    if (strategy === 'dde') {
      return await this.invokeDde(command, argument);
    }
    if (strategy === 'activex') {
      const activeX = await this.invokeActiveX(command, argument, createActiveXIfMissing && this.allowActiveXAutoStart);
      if (activeX.ok) return activeX;
      const dde = await this.invokeDde(command, argument);
      return dde.ok ? { ...dde, fallbackFrom: activeX } : { ...dde, error: `ActiveX bridge failed: ${activeX.error} DDE fallback failed: ${dde.error}`, fallbackFrom: activeX };
    }
    const dde = await this.invokeDde(command, argument);
    if (dde.ok) return dde;
    const activeX = await this.invokeActiveX(command, argument, createActiveXIfMissing && this.allowActiveXAutoStart);
    return activeX.ok ? { ...activeX, fallbackFrom: dde } : { ...activeX, error: `DDE bridge failed: ${dde.error} ActiveX fallback failed: ${activeX.error}`, fallbackFrom: dde };
  }

  private async ensureDdeSession(): Promise<boolean> {
    const workspacePath = this.workspaces.currentWorkspace?.path ?? this.workspaces.activeProjectRef?.absolutePath ?? '';
    if (this.ddeSession && this.ddeSession.workspacePath === workspacePath && !this.ddeSession.process.killed) {
      return true;
    }
    if (this.ddeSession) {
      this.closeDdeSession('workspace changed');
    }
    const ready = await this.startDdeSession(workspacePath);
    if (!ready.ok) {
      this.logResponse(ready);
      this.closeDdeSession('session startup failed');
      return false;
    }
    this.output.appendLine(`[CVI] Persistent DDE session handshake accepted${ready.mode ? ` (${ready.mode})` : ''}.`);
    this.logBootstrap(ready.bootstrap);
    this.output.appendLine(`[CVI] Persistent DDE debug session connected for ${workspacePath || '<unknown workspace>'}.`);
    this.serverAvailable = true;
    this.publishChange();
    return true;
  }

  private async startDdeSession(workspacePath: string): Promise<BridgePayload> {
    const timeout = Math.max(500, vscode.workspace.getConfiguration('labwindowsCvi').get<number>('nativeCommandTimeoutMs', 3000));
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.bridgeScript, '-Command', '__session__', '-TimeoutMs', String(timeout), '-Session'];
    const child = spawn(this.powershellExecutable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let resolveReady!: (payload: BridgePayload) => void;
    const readyPromise = new Promise<BridgePayload>((resolve) => { resolveReady = resolve; });
    const handle: DdeSessionHandle = {
      process: child,
      buffer: '',
      stderr: '',
      pending: new Map<string, DdeSessionPending>(),
      readyPromise,
      resolveReady,
      readySettled: false,
      workspacePath
    };
    this.ddeSession = handle;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consumeDdeSessionOutput(handle, chunk));
    child.stderr.on('data', (chunk: string) => { handle.stderr += chunk; });
    child.on('error', (error) => this.failDdeSession(handle, `Persistent DDE bridge process error: ${error.message}`));
    child.on('close', (code, signal) => this.failDdeSession(handle, `Persistent DDE bridge process exited (code=${String(code)}, signal=${String(signal)}).${handle.stderr.trim() ? ` stderr: ${handle.stderr.trim()}` : ''}`));
    const startupTimeout = Math.max(5000, vscode.workspace.getConfiguration('labwindowsCvi').get<number>('nativeDdeSessionStartupTimeoutMs', 15000));
    const timer = setTimeout(() => {
      this.failDdeSession(handle, 'Persistent DDE bridge startup timed out.');
      if (!child.killed) child.kill();
    }, startupTimeout);
    const ready = await readyPromise;
    clearTimeout(timer);
    return ready;
  }

  private consumeDdeSessionOutput(handle: DdeSessionHandle, chunk: string): void {
    handle.buffer += chunk;
    while (true) {
      const newline = handle.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = handle.buffer.slice(0, newline).replace(/^\uFEFF/, '').trim();
      handle.buffer = handle.buffer.slice(newline + 1);
      if (!line) continue;
      let payload: DdeSessionPayload | undefined;
      try {
        payload = JSON.parse(line) as DdeSessionPayload;
      } catch {
        this.output.appendLine(`[CVI] Persistent DDE bridge output: ${line}`);
        continue;
      }
      if (payload.event === 'ready') {
        if (!handle.readySettled) {
          handle.readySettled = true;
          handle.resolveReady(payload);
        }
        continue;
      }
      if (payload.id) {
        const pending = handle.pending.get(payload.id);
        if (pending) {
          clearTimeout(pending.timer);
          handle.pending.delete(payload.id);
          pending.resolve(payload);
        }
      }
    }
  }

  private failDdeSession(handle: DdeSessionHandle, error: string): void {
    if (!handle.readySettled) {
      handle.readySettled = true;
      handle.resolveReady({ ok: false, transport: 'dde-session', command: '', argument: '', raw: '', error });
    }
    for (const [id, pending] of handle.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, transport: 'dde-session', command: '', argument: '', raw: '', error: `${error} Pending request: ${id}.` });
    }
    handle.pending.clear();
    if (this.ddeSession === handle) {
      this.ddeSession = undefined;
      if (this.cachedProjectExecution !== 'idle') this.cachedProjectExecution = 'unknown';
      this.stateSource = 'unknown';
      this.lastUpdatedAt = Date.now();
      this.publishChange();
    }
  }

  private closeDdeSession(reason: string): void {
    const handle = this.ddeSession;
    if (!handle) return;
    this.output.appendLine(`[CVI] Closing persistent DDE debug session: ${reason}.`);
    this.ddeSession = undefined;
    this.lastUpdatedAt = Date.now();
    this.publishChange();
    try {
      handle.process.stdin.write(`${JSON.stringify({ id: `close-${Date.now()}`, command: '__close__', argument: '', timeoutMs: 1000 })}\n`);
    } catch {
      // The process may already have terminated.
    }
    setTimeout(() => { if (!handle.process.killed) handle.process.kill(); }, 750);
  }

  private async invokeDdeSession(command: string, argument: string, options: DdeSessionInvokeOptions = {}): Promise<BridgePayload> {
    const handle = this.ddeSession;
    if (!handle || handle.process.killed || !handle.process.stdin.writable) {
      return { ok: false, transport: 'dde-session', command, argument, raw: '', error: 'No persistent DDE debug session is connected.' };
    }
    const id = `dde-${Date.now()}-${++this.ddeSessionSequence}`;
    const timeoutMs = Math.max(500, options.timeoutMs ?? vscode.workspace.getConfiguration('labwindowsCvi').get<number>('nativeCommandTimeoutMs', 3000));
    return await new Promise<BridgePayload>((resolve) => {
      const timer = setTimeout(() => {
        handle.pending.delete(id);
        resolve({ ok: false, transport: 'dde-session', command, argument, raw: '', error: `Persistent DDE command timed out: ${command}.` });
        if (options.closeOnTimeout !== false) this.closeDdeSession(`command timeout: ${command}`);
      }, Math.max(1500, timeoutMs + 1500));
      handle.pending.set(id, { resolve, timer });
      try {
        handle.process.stdin.write(`${JSON.stringify({ id, command, argument, timeoutMs })}\n`);
      } catch (error) {
        clearTimeout(timer);
        handle.pending.delete(id);
        resolve({ ok: false, transport: 'dde-session', command, argument, raw: '', error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  private startNativeCompletionMonitor(): void {
    if (this.nativeCompletionMonitor) return;
    const interval = Math.max(500, vscode.workspace.getConfiguration('labwindowsCvi').get<number>('nativeExecutionMonitorIntervalMs', 1500));
    this.nativeCompletionMonitor = setInterval(() => { void this.pollNativeCompletion(); }, interval);
  }

  private stopNativeCompletionMonitor(): void {
    if (this.nativeCompletionMonitor) clearInterval(this.nativeCompletionMonitor);
    this.nativeCompletionMonitor = undefined;
    this.nativeCompletionMonitorInFlight = false;
  }

  private async pollNativeCompletion(): Promise<void> {
    if (this.nativeCompletionMonitorInFlight) return;
    if (this.cachedProjectExecution !== 'running' && this.cachedProjectExecution !== 'suspended') {
      this.stopNativeCompletionMonitor();
      return;
    }
    this.nativeCompletionMonitorInFlight = true;
    try {
      // Use an independent short-lived DDE probe. During native execution CVI
      // may reject fresh conversations; that is expected and intentionally
      // ignored. Once the program completes, the probe succeeds and the
      // dashboard returns to idle without disturbing the persistent session.
      const response = await this.invokeDde(COMMANDS.state, '');
      if (!response.ok) return;
      const state = this.parseState(response.raw);
      if (!state) return;
      this.rememberState(state);
      if (state.projectExecution === 'idle') {
        this.stopNativeCompletionMonitor();
        this.closeDdeSession('native program completed');
        this.publishChange();
      }
    } finally {
      this.nativeCompletionMonitorInFlight = false;
    }
  }

  private async invokeActiveX(command: string, argument: string, createIfMissing: boolean): Promise<BridgePayload> {
    if (process.platform !== 'win32') {
      return { ok: false, transport: 'activex', command, argument, raw: '', error: 'The native bridge is supported only on Windows.' };
    }
    if (!fs.existsSync(this.activeXCommandScript)) {
      return { ok: false, transport: 'activex', command, argument, raw: '', error: `ActiveX command script not found: ${this.activeXCommandScript}` };
    }
    const timeout = Math.max(500, vscode.workspace.getConfiguration('labwindowsCvi').get<number>('nativeCommandTimeoutMs', 3000));
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.activeXCommandScript, '-Command', command];
    if (argument.length > 0) {
      args.push('-Argument', argument);
    }
    args.push('-TimeoutMs', String(timeout));
    if (createIfMissing) {
      args.push('-CreateIfMissing');
    }
    return await new Promise<BridgePayload>((resolve) => {
      const hostTimeout = Math.max(5000, vscode.workspace.getConfiguration('labwindowsCvi').get<number>('nativeActiveXProcessTimeoutMs', 15000));
      execFile(this.powershellExecutable, args, { windowsHide: true, timeout: hostTimeout, encoding: 'utf8' }, (error, stdout, stderr) => {
        const payload = this.tryParseLastJsonLine<BridgePayload>(stdout);
        if (payload) {
          resolve(payload);
          return;
        }
        resolve({ ok: false, transport: 'activex', command, argument, raw: '', error: this.describePowerShellFailure('Native ActiveX bridge', error, stdout, stderr) });
      });
    });
  }

  private async invokeDde(command: string, argument: string): Promise<BridgePayload> {
    if (process.platform !== 'win32') {
      return { ok: false, transport: 'dde', command, argument, raw: '', error: 'The native bridge is supported only on Windows.' };
    }
    if (!fs.existsSync(this.bridgeScript)) {
      return { ok: false, transport: 'dde', command, argument, raw: '', error: `DDE fallback script not found: ${this.bridgeScript}` };
    }
    const timeout = Math.max(500, vscode.workspace.getConfiguration('labwindowsCvi').get<number>('nativeCommandTimeoutMs', 3000));
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.bridgeScript, '-Command', command];
    if (argument.length > 0) {
      args.push('-Argument', argument);
    }
    args.push('-TimeoutMs', String(timeout));
    return await new Promise<BridgePayload>((resolve) => {
      const hostTimeout = Math.max(30000, vscode.workspace.getConfiguration('labwindowsCvi').get<number>('nativeBridgeProcessTimeoutMs', 90000));
      execFile(this.powershellExecutable, args, { windowsHide: true, timeout: hostTimeout, encoding: 'utf8' }, (error, stdout, stderr) => {
        const payload = this.tryParseLastJsonLine<BridgePayload>(stdout);
        if (payload) {
          resolve(payload);
          return;
        }
        resolve({ ok: false, transport: 'dde', command, argument, raw: '', error: this.describePowerShellFailure('Native DDE fallback bridge', error, stdout, stderr) });
      });
    });
  }

  private async startNativeIde(executable: string, openPath: string, background: boolean): Promise<void> {
    if (background && fs.existsSync(this.backgroundStartScript)) {
      const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.backgroundStartScript, '-Executable', executable, '-Target', openPath, '-WindowMode', this.nativeDebuggerIdeWindowMode === 'normal' ? 'Normal' : 'Minimized'];
      const launched = await new Promise<boolean>((resolve) => {
        execFile(this.powershellExecutable, args, { windowsHide: true, timeout: 10000, encoding: 'utf8' }, (error) => resolve(!error));
      });
      if (launched) {
        this.output.appendLine(`[CVI] Started native IDE in ${this.nativeDebuggerIdeWindowMode} background mode for VS Code debugging: ${executable} ${openPath}`);
        return;
      }
      this.output.appendLine('[CVI] Background launch helper failed; falling back to the standard native IDE launcher.');
    }
    const child = spawn(executable, [openPath], { cwd: path.dirname(openPath), detached: true, shell: false, stdio: 'ignore', windowsHide: background });
    child.unref();
    this.output.appendLine(`[CVI] Started native IDE for DDE command bridge: ${executable} ${openPath}`);
  }

  keepNativeIdeInBackground(): void {
    if (!this.keepNativeIdeMinimizedDuringVsCodeDebug || process.platform !== 'win32' || !fs.existsSync(this.windowControlScript)) return;
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.windowControlScript, '-Action', 'Minimize'];
    execFile(this.powershellExecutable, args, { windowsHide: true, timeout: 5000, encoding: 'utf8' }, () => undefined);
  }

  private scheduleDebugAdapterPoll(delayMs = this.nativeDapPollIntervalMs): void {
    if (this.debugAdapterMonitorUsers <= 0 || this.debugAdapterPollTimer) return;
    this.debugAdapterPollTimer = setTimeout(() => {
      this.debugAdapterPollTimer = undefined;
      void this.pollDebugAdapterState();
    }, delayMs);
  }

  private stopDebugAdapterMonitoring(): void {
    if (this.debugAdapterPollTimer) clearTimeout(this.debugAdapterPollTimer);
    this.debugAdapterPollTimer = undefined;
    this.debugAdapterPollInFlight = false;
    this.debugAdapterPollFailures = 0;
  }

  private async pollDebugAdapterState(): Promise<void> {
    if (this.debugAdapterMonitorUsers <= 0) return;
    if (this.debugAdapterPollInFlight || !this.ddeSession || this.cachedProjectExecution === 'idle') {
      this.scheduleDebugAdapterPoll();
      return;
    }
    this.debugAdapterPollInFlight = true;
    try {
      const response = await this.invokeDdeSession(COMMANDS.state, '', { timeoutMs: this.nativeDapPollTimeoutMs, closeOnTimeout: false });
      if (response.ok) {
        const state = this.parseState(response.raw);
        if (state) {
          this.debugAdapterPollFailures = 0;
          this.rememberState(state, 'poll');
        }
      } else {
        this.debugAdapterPollFailures += 1;
        if (this.debugAdapterPollFailures === 1) this.output.appendLine(`[CVI] VS Code debug state polling temporarily unavailable: ${response.error}`);
      }
    } finally {
      this.debugAdapterPollInFlight = false;
      const backoff = this.debugAdapterPollFailures >= 2 ? Math.max(2000, this.nativeDapPollIntervalMs * 3) : this.nativeDapPollIntervalMs;
      this.scheduleDebugAdapterPoll(backoff);
    }
  }

  private async waitAfterNativeIdeStartup(): Promise<void> {
    const delayMs = Math.max(0, vscode.workspace.getConfiguration('labwindowsCvi').get<number>('nativePostIdeStartDelayMs', 2000));
    if (delayMs > 0) {
      this.output.appendLine(`[CVI] Waiting ${delayMs} ms after native IDE startup before sending the debug command.`);
      await delay(delayMs);
    }
  }

  private get nativeDebuggerIdeWindowMode(): 'normal' | 'minimized' {
    return vscode.workspace.getConfiguration('labwindowsCvi').get<string>('nativeDebuggerIdeWindowMode', 'minimized') === 'normal' ? 'normal' : 'minimized';
  }

  private get keepNativeIdeMinimizedDuringVsCodeDebug(): boolean {
    return vscode.workspace.getConfiguration('labwindowsCvi').get<boolean>('keepNativeIdeMinimizedDuringVsCodeDebug', true);
  }

  private get nativeDapPollIntervalMs(): number {
    return Math.max(300, vscode.workspace.getConfiguration('labwindowsCvi').get<number>('nativeDapPollIntervalMs', 750));
  }

  private get nativeDapPollTimeoutMs(): number {
    return Math.max(500, vscode.workspace.getConfiguration('labwindowsCvi').get<number>('nativeDapPollTimeoutMs', 1000));
  }

  private async discoverActiveX(): Promise<ActiveXDiscoveryPayload> {
    if (process.platform !== 'win32') {
      return { ok: false, transport: 'activex-discovery', candidates: [], error: 'ActiveX discovery is supported only on Windows.' };
    }
    if (!fs.existsSync(this.activeXDiscoveryScript)) {
      return { ok: false, transport: 'activex-discovery', candidates: [], error: `ActiveX discovery script not found: ${this.activeXDiscoveryScript}` };
    }
    return await new Promise<ActiveXDiscoveryPayload>((resolve) => {
      const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.activeXDiscoveryScript];
      const discoveryTimeout = Math.max(3000, vscode.workspace.getConfiguration('labwindowsCvi').get<number>('activeXDiscoveryTimeoutMs', 10000));
      execFile(this.powershellExecutable, args, { windowsHide: true, timeout: discoveryTimeout, encoding: 'utf8' }, (error, stdout, stderr) => {
        const payload = this.tryParseLastJsonLine<ActiveXDiscoveryPayload>(stdout);
        if (payload) {
          resolve({
            ...payload,
            candidates: Array.isArray(payload.candidates) ? payload.candidates : [],
            scannedRoots: Array.isArray(payload.scannedRoots) ? payload.scannedRoots : [],
            warnings: Array.isArray(payload.warnings) ? payload.warnings : []
          });
          return;
        }
        resolve({ ok: false, transport: 'activex-discovery', candidates: [], error: this.describePowerShellFailure('ActiveX registry discovery', error, stdout, stderr) });
      });
    });
  }

  private tryParseLastJsonLine<T>(stdout: string): T | undefined {
    const lines = stdout.split(/\r?\n/).map((line) => line.replace(/^\uFEFF/, '').trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index]) as T;
      } catch {
        // PowerShell can emit informational lines before the JSON result. Continue
        // scanning backwards so the bridge remains tolerant of host diagnostics.
      }
    }
    return undefined;
  }

  private describePowerShellFailure(label: string, error: Error | null, stdout: string, stderr: string): string {
    const processError = error as (Error & { code?: string | number; signal?: string; killed?: boolean }) | null;
    const details: string[] = [];
    const stderrText = stderr.trim();
    const stdoutText = stdout.trim();
    if (processError?.message.trim()) details.push(processError.message.trim());
    if (processError?.code !== undefined) details.push(`exit/code=${String(processError.code)}`);
    if (processError?.signal) details.push(`signal=${processError.signal}`);
    if (processError?.killed) details.push('process terminated by timeout');
    if (stderrText) details.push(`stderr: ${stderrText}`);
    if (stdoutText) details.push(`stdout: ${stdoutText}`);
    return details.length > 0 ? `${label} failed. ${details.join(' | ')}` : `${label} failed without stdout or stderr.`;
  }

  private formatBridgeError(response: BridgePayload): string {
    const failures = (response.attempts ?? []).filter((attempt) => !attempt.ok);
    if (failures.length === 0) return response.error;
    const summary = failures.map((attempt) => `${attempt.mode}: ${attempt.ddeErrorName || attempt.error || (attempt.ddeError !== undefined ? `DDEML error ${attempt.ddeError}` : 'failed')}`).join(' · ');
    return `${response.error} Attempts: ${summary}.`;
  }

  private logActiveXDiscovery(discovery: ActiveXDiscoveryPayload): void {
    this.output.appendLine(`[CVI] ActiveX registry discovery -> ${discovery.ok ? `${discovery.candidates.length} candidate(s)` : discovery.error}`);
    for (const root of discovery.scannedRoots ?? []) {
      this.output.appendLine(`[CVI]   ActiveX scanned root: ${root}`);
    }
    for (const warning of discovery.warnings ?? []) {
      this.output.appendLine(`[CVI]   ActiveX discovery warning: ${warning}`);
    }
    for (const candidate of discovery.candidates) {
      this.output.appendLine(`[CVI] ActiveX candidate: kind=${candidate.kind || '<unknown>'} · view=${candidate.registryView || '<unknown>'} · CLSID=${candidate.clsid || '<none>'} · ProgID=${candidate.progId || '<none>'} · VersionIndependentProgID=${candidate.versionIndependentProgId || '<none>'}`);
      this.output.appendLine(`[CVI]   Description: ${candidate.description || '<none>'}`);
      this.output.appendLine(`[CVI]   LocalServer32: ${candidate.localServer32 || '<none>'}`);
      this.output.appendLine(`[CVI]   InprocServer32: ${candidate.inprocServer32 || '<none>'}`);
      this.output.appendLine(`[CVI]   Registry: ${candidate.registryPath || '<none>'}`);
    }
  }

  private get nativeCommandTransport(): 'dde' | 'auto' | 'activex' {
    const value = vscode.workspace.getConfiguration('labwindowsCvi').get<string>('nativeCommandTransport', 'dde');
    return value === 'auto' || value === 'activex' ? value : 'dde';
  }

  private get allowActiveXAutoStart(): boolean {
    return vscode.workspace.getConfiguration('labwindowsCvi').get<boolean>('allowActiveXAutoStart', false);
  }

  private get powershellExecutable(): string {
    return vscode.workspace.getConfiguration('labwindowsCvi').get<string>('powershellExecutable', 'powershell.exe').trim() || 'powershell.exe';
  }

  private rememberState(state: CviNativeState, origin: CviNativeExecutionTransition['origin'] = 'native'): void {
    this.serverAvailable = true;
    const previousExecution = this.cachedProjectExecution;
    this.cachedProjectExecution = state.projectExecution;
    this.projectCompiledAndLinked = state.projectCompiledAndLinked;
    this.waitingForUserResponse = state.waitingForUserResponse;
    this.stateSource = 'native';
    this.lastUpdatedAt = Date.now();
    this.publishChange();
    if (previousExecution !== this.cachedProjectExecution) this.executionTransitionEmitter.fire({ previous: previousExecution, current: this.cachedProjectExecution, origin });
  }

  private setCachedExecution(execution: CviNativeState['projectExecution'], origin: CviNativeExecutionTransition['origin'] = 'cached'): void {
    const previousExecution = this.cachedProjectExecution;
    this.cachedProjectExecution = execution;
    this.stateSource = 'cached';
    this.lastUpdatedAt = Date.now();
    this.publishChange();
    if (previousExecution !== this.cachedProjectExecution) this.executionTransitionEmitter.fire({ previous: previousExecution, current: this.cachedProjectExecution, origin });
  }

  private markAction(command: string, result: string): void {
    this.lastCommand = command;
    this.lastResult = result;
    this.lastUpdatedAt = Date.now();
    this.publishChange();
  }

  private publishChange(): void {
    this.changeEmitter.fire();
  }

  private parseCommandStatus(raw: string): number {
    const match = raw.trim().match(/^-?\d+/);
    return match ? Number(match[0]) : Number.NaN;
  }

  private normalizeCommandStatus(status: number): number {
    if (!Number.isFinite(status) || status >= 0) return status;
    const unsigned = status >>> 0;
    return (unsigned & 0xFFFF0000) === 0x80040000 ? -(unsigned & 0xFFFF) : status;
  }

  private parseState(raw: string): CviNativeState | undefined {
    const values = raw.trim().split(/\s+/).map(Number);
    if (values.length < 6 || values.some((value) => !Number.isFinite(value))) {
      return undefined;
    }
    return {
      raw,
      commandStatus: values[0],
      projectCompiledAndLinked: values[1] === 1,
      projectExecution: renderExecution(values[2]),
      interactiveWindowCompiledAndLinked: values[3] === 1,
      interactiveWindowExecution: renderExecution(values[4]),
      waitingForUserResponse: values[5] === 1,
      queuedKeystrokes: values[6] ?? 0
    };
  }

  private describeCommandStatus(status: number): string {
    if (!Number.isFinite(status)) return 'Malformed command-server status response';
    if (status === 0) return 'Command accepted';
    if (status < 0) return CVI_COMMAND_ERRORS[Math.abs(status)] ?? 'Unknown command-server error';
    const possible = CVI_COMMAND_ERRORS[status];
    return possible
      ? `Unexpected positive command-server status; possible CVI error: ${possible}`
      : 'Unexpected positive command-server status';
  }

  private renderState(state: CviNativeState): string {
    const linked = state.projectCompiledAndLinked ? 'linked' : 'not linked';
    const waiting = state.waitingForUserResponse ? ' · waiting for a CVI dialog response' : '';
    return `Native CVI state: project ${linked} · execution ${state.projectExecution}${waiting}.`;
  }

  private logResponse(response: BridgePayload): void {
    if (response.fallbackFrom) {
      this.logSingleResponse(response.fallbackFrom, true);
    }
    this.logSingleResponse(response, false);
  }

  private logSingleResponse(response: BridgePayload, fallbackSource: boolean): void {
    const transport = response.transport ?? 'unknown-transport';
    const prefix = fallbackSource ? `${transport} primary attempt` : transport;
    this.output.appendLine(`[CVI] ${prefix} ${response.command}${response.argument ? `,${response.argument}` : ''} -> ${response.ok ? response.raw : response.error}`);
    if (transport === 'activex') {
      this.output.appendLine(`[CVI]   ActiveX ProgID: ${response.progId || 'CVI.Application'} · connection=${response.connectionMode || '<none>'} · method=${response.method || '<none>'}`);
      for (const attempt of response.attempts ?? []) {
        this.output.appendLine(`[CVI]   ActiveX attempt ${attempt.mode}: ${attempt.ok ? 'connected' : attempt.error}`);
      }
      return;
    }
    this.logBootstrap(response.bootstrap);
    for (const attempt of response.attempts ?? []) {
      this.output.appendLine(`[CVI]   DDE attempt ${attempt.mode}: ${attempt.ok ? 'connected' : `${attempt.stage || 'unknown-stage'} · ${attempt.ddeError ?? 0} (${attempt.ddeErrorName || 'DMLERR_UNKNOWN'}) · ${attempt.error}`}`);
    }
  }

  private logBootstrap(bootstrap?: BridgeBootstrap): void {
    if (!bootstrap) return;
    this.output.appendLine(`[CVI]   DDE helper cache: ${bootstrap.assemblyPath || '<none>'} · ${bootstrap.compiled ? 'compiled now' : bootstrap.loadedFromCache ? 'loaded from cache' : 'not initialized'}`);
    for (const warning of bootstrap.warnings ?? []) {
      this.output.appendLine(`[CVI]   DDE helper warning: ${warning}`);
    }
  }
}

function renderExecution(value: number): CviNativeState['projectExecution'] {
  if (value === 0) return 'idle';
  if (value === 1) return 'running';
  if (value === 2) return 'suspended';
  return 'unknown';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
