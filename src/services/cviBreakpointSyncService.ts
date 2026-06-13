import * as path from 'path';
import * as vscode from 'vscode';
import { CviParser, CviWorkspaceBreakpoint, CviWorkspaceBreakpointSyncResult } from '../model/cviParser';
import { CviWorkspaceProjectRef } from '../model/types';
import { CviWorkspaceService } from './cviWorkspaceService';

const BREAKPOINT_SYNC_STATE_KEY = 'labwindowsCvi.breakpointSyncState.v1';

interface BreakpointSyncState {
  [workspacePath: string]: {
    [projectPath: string]: CviWorkspaceBreakpoint[];
  };
}

interface CollectedBreakpoints {
  supported: CviWorkspaceBreakpoint[];
  skippedDisabled: number;
  skippedConditional: number;
  skippedNonSource: number;
}

export class CviBreakpointSyncService {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly parser: CviParser,
    private readonly workspaces: CviWorkspaceService,
    private readonly output: vscode.OutputChannel
  ) {}

  async synchronize(projectRef?: CviWorkspaceProjectRef, showMessage = true): Promise<CviWorkspaceBreakpointSyncResult | undefined> {
    const workspace = this.requireNativeWorkspace();
    const ref = projectRef ?? this.workspaces.activeProjectRef;
    if (!workspace || !ref?.exists) {
      if (!ref?.exists) {
        vscode.window.showErrorMessage('No existing CVI project is available for breakpoint synchronization.');
      }
      return undefined;
    }

    const collected = this.collectVsCodeBreakpoints();
    const tracked = this.getTracked(workspace.path, ref.absolutePath);
    const preserveNative = this.preserveNativeBreakpoints;
    const result = this.parser.synchronizeWorkspaceBreakpoints(workspace.path, ref.index, ref.absolutePath, collected.supported, tracked, preserveNative);
    await this.setTracked(workspace.path, ref.absolutePath, result.trackedBreakpoints);
    this.logResult('Synchronized', workspace.path, ref, result, collected);
    if (showMessage) {
      vscode.window.showInformationMessage(this.renderSummary('Synchronized', result, collected));
    }
    return result;
  }

  async clear(projectRef?: CviWorkspaceProjectRef): Promise<CviWorkspaceBreakpointSyncResult | undefined> {
    const workspace = this.requireNativeWorkspace();
    const ref = projectRef ?? this.workspaces.activeProjectRef;
    if (!workspace || !ref?.exists) {
      if (!ref?.exists) {
        vscode.window.showErrorMessage('No existing CVI project is available for breakpoint cleanup.');
      }
      return undefined;
    }
    const tracked = this.getTracked(workspace.path, ref.absolutePath);
    const result = this.parser.synchronizeWorkspaceBreakpoints(workspace.path, ref.index, ref.absolutePath, [], tracked, this.preserveNativeBreakpoints);
    await this.setTracked(workspace.path, ref.absolutePath, []);
    this.logResult('Removed synchronized', workspace.path, ref, result, {
      supported: [], skippedDisabled: 0, skippedConditional: 0, skippedNonSource: 0
    });
    vscode.window.showInformationMessage(`Removed ${result.removedTrackedCount} synchronized breakpoint(s) from ${path.basename(workspace.path)}. Native CVI breakpoints were preserved.`);
    return result;
  }

  async diagnose(projectRef?: CviWorkspaceProjectRef): Promise<void> {
    const workspace = this.requireNativeWorkspace();
    const ref = projectRef ?? this.workspaces.activeProjectRef;
    if (!workspace || !ref?.exists) {
      if (!ref?.exists) {
        vscode.window.showErrorMessage('No existing CVI project is available for breakpoint diagnostics.');
      }
      return;
    }
    const collected = this.collectVsCodeBreakpoints();
    const tracked = this.getTracked(workspace.path, ref.absolutePath);
    this.output.show(true);
    this.output.appendLine('[CVI] Native breakpoint bridge diagnostics');
    this.output.appendLine(`[CVI] Workspace: ${workspace.path}`);
    this.output.appendLine(`[CVI] Project: ${ref.name} (${ref.absolutePath})`);
    this.output.appendLine(`[CVI] Supported VS Code source breakpoints: ${collected.supported.length}`);
    this.output.appendLine(`[CVI] Previously synchronized breakpoints tracked by the extension: ${tracked.length}`);
    this.output.appendLine(`[CVI] Skipped disabled breakpoints: ${collected.skippedDisabled}`);
    this.output.appendLine(`[CVI] Skipped conditional, hit-count or log breakpoints: ${collected.skippedConditional}`);
    this.output.appendLine(`[CVI] Skipped breakpoints without a file source location: ${collected.skippedNonSource}`);
    for (const breakpoint of collected.supported) {
      this.output.appendLine(`  - ${breakpoint.filePath}:${breakpoint.line}`);
    }
    vscode.window.showInformationMessage('Native CVI breakpoint bridge diagnostics were written to the LabWindows/CVI output channel.');
  }

  private requireNativeWorkspace() {
    const workspace = this.workspaces.currentWorkspace;
    if (!workspace || path.extname(workspace.path).toLowerCase() !== '.cws') {
      vscode.window.showErrorMessage('Open a .cws LabWindows/CVI workspace before synchronizing native breakpoints. Standalone .prj files do not store native CVI workspace breakpoints.');
      return undefined;
    }
    return workspace;
  }

  private collectVsCodeBreakpoints(): CollectedBreakpoints {
    const result: CollectedBreakpoints = { supported: [], skippedDisabled: 0, skippedConditional: 0, skippedNonSource: 0 };
    for (const breakpoint of vscode.debug.breakpoints) {
      if (!(breakpoint instanceof vscode.SourceBreakpoint) || breakpoint.location.uri.scheme !== 'file') {
        result.skippedNonSource += 1;
        continue;
      }
      if (!breakpoint.enabled) {
        result.skippedDisabled += 1;
        continue;
      }
      if (breakpoint.condition || breakpoint.hitCondition || breakpoint.logMessage) {
        result.skippedConditional += 1;
        continue;
      }
      result.supported.push({
        filePath: breakpoint.location.uri.fsPath,
        line: breakpoint.location.range.start.line + 1
      });
    }
    return result;
  }

  private getTracked(workspacePath: string, projectPath: string): CviWorkspaceBreakpoint[] {
    const state = this.context.workspaceState.get<BreakpointSyncState>(BREAKPOINT_SYNC_STATE_KEY, {});
    return state[workspacePath]?.[projectPath] ?? [];
  }

  private async setTracked(workspacePath: string, projectPath: string, breakpoints: CviWorkspaceBreakpoint[]): Promise<void> {
    const state = this.context.workspaceState.get<BreakpointSyncState>(BREAKPOINT_SYNC_STATE_KEY, {});
    const workspace = { ...(state[workspacePath] ?? {}) };
    if (breakpoints.length > 0) {
      workspace[projectPath] = breakpoints;
    } else {
      delete workspace[projectPath];
    }
    const updated = { ...state };
    if (Object.keys(workspace).length > 0) {
      updated[workspacePath] = workspace;
    } else {
      delete updated[workspacePath];
    }
    await this.context.workspaceState.update(BREAKPOINT_SYNC_STATE_KEY, updated);
  }

  private get preserveNativeBreakpoints(): boolean {
    return vscode.workspace.getConfiguration('labwindowsCvi').get<string>('nativeBreakpointSynchronizationMode', 'mirror') === 'preserve-native';
  }

  private logResult(action: string, workspacePath: string, ref: CviWorkspaceProjectRef, result: CviWorkspaceBreakpointSyncResult, collected: CollectedBreakpoints): void {
    this.output.appendLine(`[CVI] ${action} VS Code breakpoints for ${ref.name} in ${workspacePath}`);
    this.output.appendLine(`[CVI] Mode: ${this.preserveNativeBreakpoints ? 'preserve-native' : 'mirror VS Code exactly'}; applied: ${result.appliedCount}; preserved native: ${result.preservedNativeCount}; removed native not present in VS Code: ${result.removedNativeCount}; removed previously synchronized: ${result.removedTrackedCount}; ignored outside active project: ${result.ignoredBreakpoints.length}.`);
    this.output.appendLine(`[CVI] Skipped disabled: ${collected.skippedDisabled}; skipped conditional/hit-count/log: ${collected.skippedConditional}; skipped non-source: ${collected.skippedNonSource}.`);
    if (result.createdWorkspaceFileSections.length > 0) {
      this.output.appendLine(`[CVI] Created native workspace file sections: ${result.createdWorkspaceFileSections.join(', ')}.`);
    }
  }

  private renderSummary(action: string, result: CviWorkspaceBreakpointSyncResult, collected: CollectedBreakpoints): string {
    const skipped = result.ignoredBreakpoints.length + collected.skippedDisabled + collected.skippedConditional + collected.skippedNonSource;
    const mode = this.preserveNativeBreakpoints ? `Preserved ${result.preservedNativeCount} native CVI breakpoint(s)` : `Removed ${result.removedNativeCount} unmatched native CVI breakpoint(s)`;
    return `${action} ${result.appliedCount} VS Code breakpoint(s) to the native CVI workspace. ${mode}${skipped > 0 ? `; skipped ${skipped} unsupported or out-of-project breakpoint(s)` : ''}.`;
  }
}
