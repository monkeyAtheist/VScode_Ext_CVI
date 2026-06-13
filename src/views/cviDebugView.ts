import * as vscode from 'vscode';
import { CviNativeCommandService, CviNativeDebugSnapshot } from '../services/cviNativeCommandService';
import { CviWorkspaceService } from '../services/cviWorkspaceService';

interface CviDebugNode {
  label: string;
  description?: string;
  tooltip?: string;
  icon?: string;
  command?: vscode.Command;
  contextValue?: string;
  children?: CviDebugNode[];
  expanded?: boolean;
}

/**
 * Compact native CVI debug dashboard. The root is split into a concise status
 * area, a list containing only actions that can currently be useful, and a
 * collapsed diagnostics area. No webview is used.
 */
export class CviDebugView implements vscode.TreeDataProvider<CviDebugNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<CviDebugNode | undefined | null | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly nativeCommands: CviNativeCommandService,
    private readonly workspaces: CviWorkspaceService
  ) {
    this.disposables.push(this.nativeCommands.onDidChange(() => this.update()));
    this.disposables.push(this.workspaces.onDidChange(() => this.update()));
  }

  update(): void {
    this.emitter.fire();
  }

  getTreeItem(element: CviDebugNode): vscode.TreeItem {
    const collapsible = element.children
      ? (element.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(element.label, collapsible);
    item.description = element.description;
    item.tooltip = element.tooltip ?? [element.label, element.description].filter(Boolean).join(' — ');
    item.contextValue = element.contextValue ?? (element.children ? 'cviDebugGroup' : 'cviDebugSummary');
    if (element.icon) item.iconPath = new vscode.ThemeIcon(element.icon);
    item.command = element.command;
    return item;
  }

  getChildren(element?: CviDebugNode): CviDebugNode[] {
    if (element?.children) return element.children;

    const snapshot = this.nativeCommands.getDebugSnapshot();
    const workspace = this.workspaces.currentWorkspace;
    const ref = this.workspaces.activeProjectRef;

    if (!workspace) {
      return [
        group('Session status', [info('No workspace loaded', 'Open or create a CVI workspace before starting native debugging.', 'info')], true, 'info'),
        group('Available actions', [action('Open workspace or project…', 'labwindowsCvi.openWorkspace', 'folder-opened')], true, 'play')
      ];
    }

    const projectLabel = ref?.exists ? ref.name : 'No active project';
    const projectTooltip = ref?.exists ? ref.absolutePath : 'Select an existing project in the CVI Workspace view.';
    const session = snapshot.sessionConnected ? 'Connected' : 'Disconnected';
    const server = snapshot.serverAvailable === undefined ? 'Unknown' : snapshot.serverAvailable ? 'Available' : 'Unavailable';
    const linked = snapshot.projectCompiledAndLinked === undefined ? 'Unknown' : snapshot.projectCompiledAndLinked ? 'Yes' : 'No';
    const source = snapshot.stateSource === 'cached' ? 'cached during native execution' : snapshot.stateSource;

    const actions: CviDebugNode[] = [];
    if (snapshot.execution !== 'running' && snapshot.execution !== 'suspended') {
      actions.push(action('Build & Run Debug', 'labwindowsCvi.nativeRun', 'play', 'Build locally, synchronize breakpoints and run in the native CVI debugger.'));
    }
    if (snapshot.sessionConnected && snapshot.execution === 'running') {
      actions.push(action('Continue', 'labwindowsCvi.nativeContinue', 'debug-continue', 'Continue from a breakpoint or run to the next breakpoint.'));
      actions.push(action('Pause', 'labwindowsCvi.nativePause', 'debug-pause'));
      actions.push(action('Stop', 'labwindowsCvi.nativeStop', 'debug-stop'));
    } else if (snapshot.sessionConnected && snapshot.execution === 'suspended') {
      actions.push(action('Continue', 'labwindowsCvi.nativeContinue', 'debug-continue', 'Continue to the next breakpoint.'));
      actions.push(action('Stop', 'labwindowsCvi.nativeStop', 'debug-stop'));
    } else if (snapshot.sessionConnected && snapshot.execution === 'unknown') {
      actions.push(action('Continue', 'labwindowsCvi.nativeContinue', 'debug-continue', 'Continue from a breakpoint or run to the next breakpoint.'));
      actions.push(action('Pause', 'labwindowsCvi.nativePause', 'debug-pause'));
      actions.push(action('Stop', 'labwindowsCvi.nativeStop', 'debug-stop'));
    }
    if (actions.length === 0) {
      actions.push(info('No native debug action available', 'Refresh the state or diagnose the bridge.', 'info'));
    }

    return [
      group('Session status', [
        info('Execution', executionLabel(snapshot), executionIcon(snapshot.execution)),
        info('Project', projectLabel, 'project', projectTooltip),
        info('Persistent session', session, snapshot.sessionConnected ? 'debug-console' : 'circle-outline'),
        info('Detailed stepping', 'Use the native CVI debugger window', 'debug-step-over'),
        info('Last result', snapshot.lastResult, resultIcon(snapshot.lastResult))
      ], true, 'debug-alt-small'),
      group('Available actions', actions, true, 'play'),
      group('Diagnostics', [
        info('Native bridge', server, snapshot.serverAvailable ? 'radio-tower' : 'debug-disconnect'),
        info('Linked', linked, snapshot.projectCompiledAndLinked ? 'pass' : 'circle-outline'),
        info('Transport', snapshot.transport.toUpperCase(), 'radio-tower'),
        info('State source', source, snapshot.stateSource === 'cached' ? 'history' : 'pulse'),
        info('Last command', snapshot.lastCommand, 'terminal'),
        action('Synchronize VS Code breakpoints now', 'labwindowsCvi.synchronizeBreakpoints', 'debug-breakpoint'),
        action('Refresh native state', 'labwindowsCvi.refreshNativeDebugView', 'refresh'),
        action('Diagnose native bridge', 'labwindowsCvi.diagnoseNativeCommandBridge', 'tools')
      ], false, 'tools')
    ];
  }

  dispose(): void {
    this.emitter.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}

function group(label: string, children: CviDebugNode[], expanded: boolean, icon: string): CviDebugNode {
  return { label, children, expanded, icon, contextValue: 'cviDebugGroup' };
}

function info(label: string, description: string, icon: string, tooltip?: string): CviDebugNode {
  return { label, description, icon, tooltip };
}

function action(label: string, command: string, icon: string, tooltip?: string): CviDebugNode {
  return { label, icon, tooltip: tooltip ?? label, contextValue: 'cviDebugCommand', command: { command, title: label } };
}

function executionLabel(snapshot: CviNativeDebugSnapshot): string {
  const suffix = snapshot.stateSource === 'cached' ? ' · cached' : '';
  return `${snapshot.execution}${suffix}`;
}

function executionIcon(execution: CviNativeDebugSnapshot['execution']): string {
  if (execution === 'running') return 'debug-start';
  if (execution === 'suspended') return 'debug-pause';
  if (execution === 'idle') return 'debug-stop';
  return 'question';
}

function resultIcon(result: string): string {
  if (/failed|rejected|unavailable|skipped/i.test(result)) return 'warning';
  if (/accepted|connected|completed|operational/i.test(result)) return 'pass';
  return 'info';
}
