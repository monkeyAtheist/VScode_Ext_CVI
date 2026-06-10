import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CviProject, CviProjectFile, CviWorkspaceProjectRef } from '../model/types';
import { CviWorkspaceService } from '../services/cviWorkspaceService';

export type CviTreeNode = WorkspaceNode | ProjectNode | FolderNode | FileNode | PlaceholderNode;

export interface WorkspaceNode { kind: 'workspace'; }
export interface ProjectNode { kind: 'project'; ref: CviWorkspaceProjectRef; }
export interface FolderNode { kind: 'folder'; ref: CviWorkspaceProjectRef; project: CviProject; folderPath: string; }
export interface FileNode { kind: 'file'; ref: CviWorkspaceProjectRef; file: CviProjectFile; }
export interface PlaceholderNode { kind: 'placeholder'; label: string; }

export class CviTreeProvider implements vscode.TreeDataProvider<CviTreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<CviTreeNode | undefined | null | void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly workspaces: CviWorkspaceService,
    private readonly extensionUri: vscode.Uri
  ) {
    this.workspaces.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this.changeEmitter.fire();
  }

  getTreeItem(element: CviTreeNode): vscode.TreeItem {
    switch (element.kind) {
      case 'workspace': return this.workspaceItem();
      case 'project': return this.projectItem(element);
      case 'folder': return this.folderItem(element);
      case 'file': return this.fileItem(element);
      case 'placeholder': return this.placeholderItem(element);
    }
  }

  getChildren(element?: CviTreeNode): CviTreeNode[] {
    const workspace = this.workspaces.currentWorkspace;
    if (!workspace) {
      return [];
    }
    if (!element) {
      return [{ kind: 'workspace' }];
    }

    switch (element.kind) {
      case 'workspace':
        return workspace.projects.map((ref) => ({ kind: 'project', ref }));
      case 'project': {
        const project = this.workspaces.getProject(element.ref);
        if (!project) {
          return [{ kind: 'placeholder', label: element.ref.exists ? 'Unable to parse project' : 'Project file not found' }];
        }
        return this.childrenForFolder(element.ref, project, '');
      }
      case 'folder':
        return this.childrenForFolder(element.ref, element.project, element.folderPath);
      case 'file':
      case 'placeholder':
        return [];
    }
  }

  private childrenForFolder(ref: CviWorkspaceProjectRef, project: CviProject, parentFolder: string): CviTreeNode[] {
    const directFolders = new Set<string>();
    const directFiles: FileNode[] = [];

    for (const file of project.files) {
      const folder = normalizeLogicalFolder(file.folder);
      if (folder === parentFolder) {
        directFiles.push({ kind: 'file', ref, file });
      }
      if (folder.startsWith(parentFolder ? `${parentFolder}/` : '')) {
        const remainder = parentFolder ? folder.slice(parentFolder.length + 1) : folder;
        const nextSegment = remainder.split('/')[0];
        if (nextSegment && `${parentFolder ? `${parentFolder}/` : ''}${nextSegment}` !== parentFolder) {
          directFolders.add(`${parentFolder ? `${parentFolder}/` : ''}${nextSegment}`);
        }
      }
    }

    for (const declared of project.folders) {
      const folder = normalizeLogicalFolder(declared);
      if (folder.startsWith(parentFolder ? `${parentFolder}/` : '')) {
        const remainder = parentFolder ? folder.slice(parentFolder.length + 1) : folder;
        const nextSegment = remainder.split('/')[0];
        if (nextSegment) {
          directFolders.add(`${parentFolder ? `${parentFolder}/` : ''}${nextSegment}`);
        }
      }
    }

    const folders: FolderNode[] = [...directFolders]
      .filter((folder) => folder !== parentFolder)
      .sort((a, b) => a.localeCompare(b))
      .map((folderPath) => ({ kind: 'folder', ref, project, folderPath }));

    directFiles.sort((a, b) => path.basename(a.file.absolutePath).localeCompare(path.basename(b.file.absolutePath)));
    return [...folders, ...directFiles];
  }

  private workspaceItem(): vscode.TreeItem {
    const workspace = this.workspaces.currentWorkspace!;
    const item = new vscode.TreeItem(workspace.name, vscode.TreeItemCollapsibleState.Expanded);
    item.description = path.extname(workspace.path).toLowerCase() === '.cws' ? `${workspace.projects.length} project(s)` : 'standalone project';
    item.tooltip = workspace.path;
    item.contextValue = 'cviWorkspace';
    item.iconPath = new vscode.ThemeIcon('root-folder');
    return item;
  }

  private projectItem(node: ProjectNode): vscode.TreeItem {
    const workspace = this.workspaces.currentWorkspace!;
    const active = node.ref.index === workspace.activeProjectIndex;
    const project = this.workspaces.getProject(node.ref);
    const item = new vscode.TreeItem(node.ref.name, vscode.TreeItemCollapsibleState.Collapsed);
    item.description = `${active ? 'active · ' : ''}${project?.targetType ?? (node.ref.exists ? 'project' : 'missing')}`;
    item.tooltip = node.ref.absolutePath;
    item.contextValue = 'cviProject';
    item.iconPath = new vscode.ThemeIcon(active ? 'star-full' : node.ref.exists ? 'project' : 'warning');
    return item;
  }

  private folderItem(node: FolderNode): vscode.TreeItem {
    const label = node.folderPath.split('/').pop() ?? node.folderPath;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
    item.contextValue = 'cviFolder';
    item.tooltip = `CVI logical folder: ${node.folderPath}`;
    item.iconPath = new vscode.ThemeIcon('folder');
    return item;
  }

  private fileItem(node: FileNode): vscode.TreeItem {
    const item = new vscode.TreeItem(path.basename(node.file.absolutePath), vscode.TreeItemCollapsibleState.None);
    item.description = statusDescription(node.file);
    item.tooltip = [
      node.file.type,
      node.file.absolutePath,
      node.file.excluded ? 'Excluded from build' : 'Included in build',
      node.file.type === 'CSource' ? `.Obj option: ${node.file.compileIntoObjectFile ? 'enabled' : 'disabled'}` : undefined
    ].filter(Boolean).join('\n');
    item.contextValue = contextValueForFile(node.file);
    item.iconPath = this.branchIconForFile(node.file);
    item.resourceUri = vscode.Uri.file(node.file.absolutePath);
    item.command = isPanel(node.file)
      ? { command: 'labwindowsCvi.openPanelInCvi', title: 'Open Panel in CVI UI Editor', arguments: [node] }
      : { command: 'labwindowsCvi.openFile', title: 'Open File', arguments: [node] };
    return item;
  }

  private branchIconForFile(file: CviProjectFile): { light: vscode.Uri; dark: vscode.Uri } {
    const kind = iconKindForFile(file);
    return {
      light: vscode.Uri.joinPath(this.extensionUri, 'media', 'tree', `${kind}-light.svg`),
      dark: vscode.Uri.joinPath(this.extensionUri, 'media', 'tree', `${kind}-dark.svg`)
    };
  }

  private placeholderItem(node: PlaceholderNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('warning');
    return item;
  }
}

function normalizeLogicalFolder(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function isPanel(file: CviProjectFile): boolean {
  return file.type === 'User Interface Resource' || path.extname(file.absolutePath).toLowerCase() === '.uir';
}

function contextValueForFile(file: CviProjectFile): string {
  const kind = file.type === 'CSource' ? 'source'
    : isPanel(file) ? 'panel'
      : file.type === 'Include' ? 'header'
        : file.type === 'Library' ? 'library'
          : 'other';
  const build = file.excluded ? 'excluded' : 'included';
  const obj = file.type === 'CSource' ? (file.compileIntoObjectFile ? 'objOn' : 'objOff') : 'objNA';
  return `cviFile.${kind}.${build}.${obj}`;
}

function statusDescription(file: CviProjectFile): string | undefined {
  const parts: string[] = [];
  if (file.excluded) {
    parts.push('excluded');
  }
  if (!file.exists) {
    parts.push('missing');
  }
  if (file.type === 'CSource' && file.compileIntoObjectFile) {
    parts.push('.obj');
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function iconKindForFile(file: CviProjectFile): string {
  if (!fs.existsSync(file.absolutePath)) {
    return 'warning';
  }
  switch (path.extname(file.absolutePath).toLowerCase()) {
    case '.c': return 'source';
    case '.h': return 'header';
    case '.uir': return 'panel';
    case '.lib': return 'library';
    case '.fp': return 'function';
    default: return 'file';
  }
}
