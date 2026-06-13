import * as vscode from 'vscode';
import { CviBuildMode } from '../model/types';
import { CviBuildService } from '../services/cviBuildService';
import { CviProjectSettingsService } from '../services/cviProjectSettingsService';
import { CviWorkspaceService } from '../services/cviWorkspaceService';

interface QuickActionsSummary {
  workspaceName: string;
  projectCount: number;
  projectName: string;
  projectPath: string;
  buildMode: CviBuildMode;
  targetType: string;
  commandLine: string;
  workingDirectory: string;
  environment: string;
  buildSteps: string;
  dependencies: string;
  files: string;
  hasMissingFiles: boolean;
}

interface QuickActionNode {
  label: string;
  description?: string;
  tooltip?: string;
  icon?: string;
  command?: vscode.Command;
  contextValue?: string;
}

/**
 * Native summary view used instead of a WebviewView.
 *
 * A contributed WebviewView starts a Chromium service worker as soon as the
 * side bar is restored. On affected VS Code installations, a stale Chromium
 * state can make every webview fail with InvalidStateError. A native tree view
 * avoids that failure path during extension activation while preserving the
 * useful project summary.
 */
export class QuickActionsView implements vscode.TreeDataProvider<QuickActionNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<QuickActionNode | undefined | null | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly workspaces: CviWorkspaceService,
    private readonly builds: CviBuildService,
    private readonly projectSettings: CviProjectSettingsService
  ) {
    this.disposables.push(this.workspaces.onDidChange(() => this.update()));
  }

  update(): void {
    this.emitter.fire();
  }

  getTreeItem(element: QuickActionNode): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.description = element.description;
    item.tooltip = element.tooltip ?? [element.label, element.description].filter(Boolean).join(' — ');
    item.contextValue = element.contextValue ?? 'cviQuickActionSummary';
    if (element.icon) {
      item.iconPath = new vscode.ThemeIcon(element.icon);
    }
    item.command = element.command;
    return item;
  }

  getChildren(): QuickActionNode[] {
    const workspace = this.workspaces.currentWorkspace;
    const ref = this.workspaces.activeProjectRef;
    if (!workspace) {
      return [
        info('No workspace loaded', 'Open or create a CVI workspace to display the active target summary.', 'info'),
        action('Open workspace or project…', 'labwindowsCvi.openWorkspace', 'folder-opened'),
        action('Create workspace and project…', 'labwindowsCvi.createWorkspaceProject', 'new-folder')
      ];
    }
    if (!ref?.exists) {
      return [
        info('No active project', 'Select an existing project in the workspace tree.', 'info'),
        action('Open workspace or project…', 'labwindowsCvi.openWorkspace', 'folder-opened')
      ];
    }

    const summary = this.createSummary();
    if (!summary) {
      return [];
    }
    return [
      info(summary.projectName, `${summary.workspaceName} · ${summary.projectCount} project${summary.projectCount === 1 ? '' : 's'}`, 'project'),
      info('Target type', summary.targetType, 'symbol-enum'),
      info('Build mode', modeDescription(summary.buildMode), 'settings-gear'),
      info('Command line', summary.commandLine, 'terminal'),
      info('Working directory', summary.workingDirectory, 'folder'),
      info('Environment', summary.environment, 'symbol-key'),
      info('Build steps', summary.buildSteps, 'list-ordered'),
      info('Dependencies', summary.dependencies, 'references'),
      info('Project files', summary.files, summary.hasMissingFiles ? 'warning' : 'pass'),
      action('Open project build settings…', 'labwindowsCvi.editBuildSettings', 'settings-gear'),
      action('Open build settings in safe mode…', 'labwindowsCvi.editBuildSettingsSafeMode', 'shield'),
      action('Debug controls…', 'labwindowsCvi.chooseNativeDebugAction', 'debug-alt-small'),
      action('Build & Run Debug', 'labwindowsCvi.nativeRun', 'play'),
      action('Pause', 'labwindowsCvi.nativePause', 'debug-pause'),
      action('Continue', 'labwindowsCvi.nativeContinue', 'debug-continue'),
      action('Stop', 'labwindowsCvi.nativeStop', 'debug-stop'),
      action('State', 'labwindowsCvi.nativeState', 'pulse')
    ];
  }

  dispose(): void {
    this.emitter.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }

  private createSummary(): QuickActionsSummary | undefined {
    const workspace = this.workspaces.currentWorkspace;
    const ref = this.workspaces.activeProjectRef;
    if (!workspace || !ref?.exists) {
      return undefined;
    }
    const project = this.workspaces.getProject(ref);
    const settings = this.projectSettings.getSettings(ref);
    const actionCounts = [settings.preBuildActions.length, settings.customBuildActions.length, settings.postBuildActions.length];
    const actionTotal = actionCounts.reduce((sum, count) => sum + count, 0);
    const missingFiles = project?.files.filter((file) => !file.exists).length ?? 0;
    const totalFiles = project?.files.length ?? 0;
    return {
      workspaceName: workspace.name,
      projectCount: workspace.projects.length,
      projectName: ref.name,
      projectPath: ref.absolutePath,
      buildMode: this.builds.buildMode,
      targetType: project?.targetType || 'Unknown',
      commandLine: configuredLabel(settings.run.arguments),
      workingDirectory: configuredLabel(settings.run.workingDirectory),
      environment: configuredLabel(settings.run.environmentOptions),
      buildSteps: actionTotal === 0 ? 'Empty' : `Pre ${actionCounts[0]} · Custom ${actionCounts[1]} · Post ${actionCounts[2]}`,
      dependencies: settings.dependencies.length === 0 ? 'None' : String(settings.dependencies.length),
      files: missingFiles === 0 ? `${totalFiles} · no missing file` : `${totalFiles} · ${missingFiles} missing`,
      hasMissingFiles: missingFiles > 0
    };
  }
}

function info(label: string, description: string, icon: string): QuickActionNode {
  return { label, description, icon };
}

function action(label: string, command: string, icon: string): QuickActionNode {
  return { label, icon, contextValue: 'cviQuickActionCommand', command: { command, title: label } };
}

function configuredLabel(value: string): string { return value.trim() ? 'Configured' : 'Empty'; }
function modeDescription(mode: CviBuildMode): string {
  switch (mode) {
    case 'release': return 'Release x86';
    case 'debug64': return 'Debug x64';
    case 'release64': return 'Release x64';
    default: return 'Debug x86';
  }
}
