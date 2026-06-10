import * as path from 'path';
import * as vscode from 'vscode';
import { CviParser } from './model/cviParser';
import { CviTreeProvider, FileNode, FolderNode, ProjectNode } from './providers/cviTreeProvider';
import { CviBuildService } from './services/cviBuildService';
import { CviCppToolsService } from './services/cviCppToolsService';
import { CviInstallationService } from './services/cviInstallationService';
import { CviWorkspaceService } from './services/cviWorkspaceService';
import { HomePanel } from './views/homePanel';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('LabWindows/CVI');
  const parser = new CviParser();
  const installations = new CviInstallationService(output);
  const cppTools = new CviCppToolsService(installations, output);
  const workspaces = new CviWorkspaceService(context, parser, installations, output);
  const builds = new CviBuildService(parser, workspaces, installations, output);
  const treeProvider = new CviTreeProvider(workspaces);
  const treeView = vscode.window.createTreeView('labwindowsCvi.workspaceExplorer', { treeDataProvider: treeProvider, showCollapseAll: true });
  const home = new HomePanel(context, workspaces, builds, installations);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  statusBar.command = 'labwindowsCvi.selectBuildMode';
  statusBar.tooltip = 'Select the LabWindows/CVI build mode';
  statusBar.show();

  const updateStatusBar = (): void => {
    const project = workspaces.activeProjectRef?.name ?? 'No CVI project';
    statusBar.text = `$(tools) CVI: ${project} · ${builds.buildMode}`;
  };

  const register = (command: string, handler: (...args: any[]) => unknown): vscode.Disposable => vscode.commands.registerCommand(command, async (...args: any[]) => {
    try {
      return await handler(...args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`[CVI] ${command} failed: ${message}`);
      vscode.window.showErrorMessage(`LabWindows/CVI: ${message}`);
      return undefined;
    }
  });

  const focusTreeThen = async (command: string): Promise<void> => {
    await vscode.commands.executeCommand('labwindowsCvi.workspaceExplorer.focus');
    await vscode.commands.executeCommand(command);
  };

  context.subscriptions.push(
    output,
    workspaces,
    home,
    cppTools,
    treeView,
    statusBar,
    workspaces.onDidChange(() => {
      updateStatusBar();
      cppTools.requestSync(workspaces.currentWorkspace);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('labwindowsCvi')) {
        updateStatusBar();
        home.update();
      }
      if (event.affectsConfiguration('labwindowsCvi.activeInstallation') || event.affectsConfiguration('labwindowsCvi.autoConfigureCppTools')) {
        cppTools.requestSync(workspaces.currentWorkspace);
      }
    }),
    register('labwindowsCvi.openHome', () => home.show()),
    register('labwindowsCvi.openWorkspace', () => workspaces.openWorkspace()),
    register('labwindowsCvi.createWorkspaceProject', () => workspaces.createWorkspaceProject()),
    register('labwindowsCvi.refresh', () => workspaces.refresh()),
    register('labwindowsCvi.configureInstallation', async () => {
      const installation = await installations.selectInstallation(workspaces.currentWorkspace?.cviDir);
      if (installation) {
        await cppTools.sync(workspaces.currentWorkspace);
        home.update();
      }
    }),
    register('labwindowsCvi.syncCppTools', () => cppTools.sync(workspaces.currentWorkspace, true)),
    register('labwindowsCvi.selectBuildMode', () => builds.selectBuildMode()),
    register('labwindowsCvi.build', () => builds.build(false)),
    register('labwindowsCvi.rebuild', () => builds.build(true)),
    register('labwindowsCvi.run', () => builds.run()),
    register('labwindowsCvi.openWorkspaceInCvi', () => builds.openWorkspaceInCvi()),
    register('labwindowsCvi.setActiveProject', (node?: ProjectNode) => workspaces.setActiveProject(node?.ref)),
    register('labwindowsCvi.buildProject', (node?: ProjectNode) => node ? builds.build(false, node.ref) : undefined),
    register('labwindowsCvi.rebuildProject', (node?: ProjectNode) => node ? builds.build(true, node.ref) : undefined),
    register('labwindowsCvi.executeProject', (node?: ProjectNode) => node ? builds.run(node.ref) : undefined),
    register('labwindowsCvi.editProjectInCvi', (node?: ProjectNode) => node ? builds.openProjectInCvi(node.ref.absolutePath) : undefined),
    register('labwindowsCvi.openProjectFile', (node?: ProjectNode) => node ? workspaces.openPath(node.ref.absolutePath) : undefined),
    register('labwindowsCvi.addExistingProject', () => workspaces.addExistingProject()),
    register('labwindowsCvi.removeProject', (node?: ProjectNode) => node ? workspaces.removeProject(node.ref) : undefined),
    register('labwindowsCvi.addFiles', (node?: ProjectNode | FolderNode) => {
      if (node?.kind === 'folder') {
        return workspaces.addFiles(node.ref, node.folderPath);
      }
      return workspaces.addFiles(node?.ref);
    }),
    register('labwindowsCvi.createNewFile', (node?: ProjectNode | FolderNode) => {
      if (node?.kind === 'folder') {
        return workspaces.createNewFile(node.ref, node.folderPath);
      }
      return workspaces.createNewFile(node?.ref);
    }),
    register('labwindowsCvi.addFolder', (node?: ProjectNode | FolderNode) => {
      if (node?.kind === 'folder') {
        return workspaces.addFolder(node.ref, node.folderPath);
      }
      return workspaces.addFolder(node?.ref);
    }),
    register('labwindowsCvi.renameFolder', (node?: FolderNode) => node ? workspaces.renameFolder(node.ref, node.folderPath) : undefined),
    register('labwindowsCvi.removeFolder', (node?: FolderNode) => node ? workspaces.removeFolder(node.ref, node.folderPath) : undefined),
    register('labwindowsCvi.removeFile', (node?: FileNode) => node ? workspaces.removeFile(node.ref, node.file.sectionName, node.file.absolutePath) : undefined),
    register('labwindowsCvi.excludeFile', (node?: FileNode) => node ? workspaces.setFileExcluded(node.ref, node.file, true) : undefined),
    register('labwindowsCvi.includeFile', (node?: FileNode) => node ? workspaces.setFileExcluded(node.ref, node.file, false) : undefined),
    register('labwindowsCvi.toggleObjOption', (node?: FileNode) => node ? workspaces.toggleCompileIntoObjectFile(node.ref, node.file) : undefined),
    register('labwindowsCvi.replaceFile', (node?: FileNode) => node ? workspaces.replaceFile(node.ref, node.file) : undefined),
    register('labwindowsCvi.compileFile', (node?: FileNode) => node ? builds.compileFile(node.file.absolutePath, node.ref) : undefined),
    register('labwindowsCvi.saveFile', (node?: FileNode) => node ? workspaces.saveFile(node.file.absolutePath) : undefined),
    register('labwindowsCvi.openPanelInCvi', (node?: FileNode) => node ? builds.openPanelInCvi(node.file.absolutePath) : undefined),
    register('labwindowsCvi.openFile', (node?: FileNode) => node ? workspaces.openPath(node.file.absolutePath) : undefined),
    register('labwindowsCvi.revealProjectFile', (node?: ProjectNode) => node ? workspaces.revealInExplorer(node.ref.absolutePath) : undefined),
    register('labwindowsCvi.revealFile', (node?: FileNode) => node ? workspaces.revealInExplorer(node.file.absolutePath) : undefined),
    register('labwindowsCvi.exploreProjectDirectory', (node?: ProjectNode) => node ? workspaces.revealInExplorer(path.dirname(node.ref.absolutePath)) : undefined),
    register('labwindowsCvi.exploreFolderDirectory', (node?: FolderNode) => node ? workspaces.revealInExplorer(workspaces.directoryForLogicalFolder(node.ref, node.folderPath)) : undefined),
    register('labwindowsCvi.exploreFileDirectory', (node?: FileNode) => node ? workspaces.revealInExplorer(path.dirname(node.file.absolutePath)) : undefined),
    register('labwindowsCvi.findProject', (node?: ProjectNode) => node ? workspaces.findInDirectory(path.dirname(node.ref.absolutePath)) : undefined),
    register('labwindowsCvi.findFolder', (node?: FolderNode) => node ? workspaces.findInDirectory(workspaces.directoryForLogicalFolder(node.ref, node.folderPath)) : undefined),
    register('labwindowsCvi.findFile', (node?: FileNode) => node ? workspaces.findInDirectory(path.dirname(node.file.absolutePath)) : undefined),
    register('labwindowsCvi.saveAll', () => vscode.commands.executeCommand('workbench.action.files.saveAll')),
    register('labwindowsCvi.expandAll', () => focusTreeThen('list.expandAll')),
    register('labwindowsCvi.collapseAll', () => focusTreeThen('list.collapseAll'))
  );

  await workspaces.restoreOrAutoLoad();
  await cppTools.sync(workspaces.currentWorkspace);
  updateStatusBar();
}

export function deactivate(): void {
  // Resources are disposed through context.subscriptions.
}
