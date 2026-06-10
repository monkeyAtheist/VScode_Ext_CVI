import * as path from 'path';
import * as vscode from 'vscode';
import { CviBuildService } from '../services/cviBuildService';
import { CviInstallationService } from '../services/cviInstallationService';
import { CviWorkspaceService } from '../services/cviWorkspaceService';

export class HomePanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly workspaces: CviWorkspaceService,
    private readonly builds: CviBuildService,
    private readonly installations: CviInstallationService
  ) {
    this.disposables.push(this.workspaces.onDidChange(() => this.update()));
  }

  dispose(): void {
    this.panel?.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      this.update();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'labwindowsCvi.home',
      'LabWindows/CVI Home',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'cvi.svg');
    this.panel.onDidDispose(() => { this.panel = undefined; });
    this.panel.webview.onDidReceiveMessage(async (message: { command?: string }) => {
      if (!message.command) {
        return;
      }
      await vscode.commands.executeCommand(message.command);
      this.update();
    });
    this.update();
  }

  update(): void {
    if (!this.panel) {
      return;
    }
    const workspace = this.workspaces.currentWorkspace;
    const activeProject = this.workspaces.activeProjectRef;
    const installation = this.installations.getActiveInstallation(workspace?.cviDir);
    const mode = this.builds.buildMode;
    this.panel.webview.html = renderHtml({
      workspace: workspace?.path,
      workspaceName: workspace?.name,
      projectName: activeProject?.name,
      projectPath: activeProject?.absolutePath,
      installation: installation?.root,
      compiler: installation?.compileExe,
      ide: installation?.ideExe,
      mode
    });
  }
}

interface HomeState {
  workspace?: string;
  workspaceName?: string;
  projectName?: string;
  projectPath?: string;
  installation?: string;
  compiler?: string;
  ide?: string;
  mode: string;
}

function renderHtml(state: HomeState): string {
  const nonce = makeNonce();
  const workspaceName = escapeHtml(state.workspaceName ?? 'No workspace loaded');
  const workspacePath = escapeHtml(state.workspace ?? 'Open an existing .cws/.prj file or create a new workspace.');
  const projectName = escapeHtml(state.projectName ?? 'No active project');
  const projectPath = escapeHtml(state.projectPath ?? 'Select an active project in the CVI Workspace view.');
  const installation = escapeHtml(state.installation ?? 'No LabWindows/CVI installation selected');
  const compiler = escapeHtml(state.compiler ? path.basename(state.compiler) : 'compile.exe not detected');
  const ide = escapeHtml(state.ide ? path.basename(state.ide) : 'cvi.exe not detected');
  const mode = escapeHtml(state.mode);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LabWindows/CVI Home</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 24px; max-width: 1080px; margin: auto; }
    h1 { font-size: 26px; margin: 0 0 6px; }
    h2 { font-size: 16px; margin: 0 0 12px; }
    .muted { color: var(--vscode-descriptionForeground); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 14px; margin-top: 22px; }
    .card { border: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); padding: 16px; border-radius: 5px; }
    .detail { font-family: var(--vscode-editor-font-family); font-size: 12px; overflow-wrap: anywhere; color: var(--vscode-descriptionForeground); margin: 5px 0 14px; }
    .tag { display: inline-block; border: 1px solid var(--vscode-panel-border); padding: 2px 7px; border-radius: 10px; font-size: 12px; margin-right: 5px; }
    .actions { display: flex; flex-wrap: wrap; gap: 7px; }
    button { border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); padding: 7px 10px; cursor: pointer; border-radius: 2px; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  </style>
</head>
<body>
  <h1>LabWindows/CVI Project Manager</h1>
  <div class="muted">Manage CVI workspaces and projects without maintaining VS Code task or launch files.</div>

  <div class="grid">
    <section class="card">
      <h2>Workspace</h2>
      <strong>${workspaceName}</strong>
      <div class="detail">${workspacePath}</div>
      <div class="actions">
        <button data-command="labwindowsCvi.openWorkspace">Open</button>
        <button class="secondary" data-command="labwindowsCvi.createWorkspaceProject">Create</button>
        <button class="secondary" data-command="labwindowsCvi.openWorkspaceInCvi">Open in CVI</button>
      </div>
    </section>

    <section class="card">
      <h2>Active project</h2>
      <strong>${projectName}</strong>
      <div class="detail">${projectPath}</div>
      <span class="tag">${mode}</span>
      <div class="actions" style="margin-top:14px">
        <button data-command="labwindowsCvi.build">Build</button>
        <button class="secondary" data-command="labwindowsCvi.rebuild">Rebuild</button>
        <button class="secondary" data-command="labwindowsCvi.run">Run</button>
        <button class="secondary" data-command="labwindowsCvi.debugInCvi">Debug in CVI</button>
        <button class="secondary" data-command="labwindowsCvi.selectBuildMode">Build mode</button>
      </div>
    </section>

    <section class="card">
      <h2>CVI libraries</h2>
      <strong>Embedded CVI function explorer</strong>
      <div class="detail">Browse CVI APIs, search symbols and open the parameterized prototype page from the CVI Libraries view.</div>
      <div class="actions">
        <button data-command="labwindowsCvi.library.findFunction">Find symbol</button>
        <button class="secondary" data-command="labwindowsCvi.library.reloadPacks">Reload pack</button>
      </div>
    </section>

    <section class="card">
      <h2>Templates and snippets</h2>
      <strong>CVI starter files and reusable code fragments</strong>
      <div class="detail">Create .c, .h, .uir, DLL and error-management baselines. Save your own creation templates or insert snippets at the active cursor position.</div>
      <div class="actions">
        <button data-command="labwindowsCvi.createNewFile">Create file</button>
        <button class="secondary" data-command="labwindowsCvi.insertSnippet">Insert snippet</button>
        <button class="secondary" data-command="labwindowsCvi.manageFileTemplates">Manage templates</button>
        <button class="secondary" data-command="labwindowsCvi.manageSnippets">Manage snippets</button>
      </div>
    </section>

    <section class="card">
      <h2>LabWindows/CVI installation</h2>
      <strong>${installation}</strong>
      <div class="detail">${compiler} · ${ide}</div>
      <div class="actions">
        <button data-command="labwindowsCvi.configureInstallation">Select installation</button>
        <button class="secondary" data-command="labwindowsCvi.syncCppTools">Sync IntelliSense</button>
      </div>
    </section>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('[data-command]').forEach((button) => {
      button.addEventListener('click', () => vscode.postMessage({ command: button.dataset.command }));
    });
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function makeNonce(): string {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let index = 0; index < 32; index += 1) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}
