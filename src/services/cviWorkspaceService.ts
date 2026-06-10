import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CviParser, defaultFolderForType } from '../model/cviParser';
import { CviProject, CviProjectFile, CviWorkspace, CviWorkspaceProjectRef } from '../model/types';
import { CviInstallationService } from './cviInstallationService';

const LAST_WORKSPACE_KEY = 'labwindowsCvi.lastWorkspace';

export class CviWorkspaceService implements vscode.Disposable {
  private workspace: CviWorkspace | undefined;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly parser: CviParser,
    private readonly installations: CviInstallationService,
    private readonly output: vscode.OutputChannel
  ) {
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((document) => {
        const extension = path.extname(document.uri.fsPath).toLowerCase();
        if (extension === '.prj' || extension === '.cws') {
          this.refresh();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.autoLoad())
    );
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.changeEmitter.dispose();
  }

  get currentWorkspace(): CviWorkspace | undefined {
    return this.workspace;
  }

  get activeProjectRef(): CviWorkspaceProjectRef | undefined {
    return this.workspace?.projects.find((project) => project.index === this.workspace?.activeProjectIndex);
  }

  get activeProject(): CviProject | undefined {
    const project = this.activeProjectRef;
    if (!project?.exists) {
      return undefined;
    }
    return this.parser.parseProject(project.absolutePath);
  }

  getProject(projectRef: CviWorkspaceProjectRef): CviProject | undefined {
    if (!projectRef.exists) {
      return undefined;
    }
    try {
      return this.parser.parseProject(projectRef.absolutePath);
    } catch (error) {
      this.output.appendLine(`[CVI] Cannot parse project ${projectRef.absolutePath}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  async restoreOrAutoLoad(): Promise<void> {
    const lastWorkspace = this.context.workspaceState.get<string>(LAST_WORKSPACE_KEY);
    if (lastWorkspace && fs.existsSync(lastWorkspace)) {
      try {
        await this.load(lastWorkspace);
        return;
      } catch (error) {
        this.output.appendLine(`[CVI] Cannot reload previous workspace: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await this.autoLoad();
  }

  async autoLoad(): Promise<void> {
    const enabled = vscode.workspace.getConfiguration('labwindowsCvi').get<boolean>('autoLoadWorkspace', true);
    if (!enabled || this.workspace) {
      return;
    }

    const folders = vscode.workspace.workspaceFolders ?? [];
    const candidates: string[] = [];
    for (const folder of folders) {
      candidates.push(...this.findFilesAtLimitedDepth(folder.uri.fsPath, '.cws', 3));
    }
    if (candidates.length === 1) {
      await this.load(candidates[0]);
    }
  }

  async openWorkspace(): Promise<void> {
    const files = await vscode.window.showOpenDialog({
      title: 'Open a LabWindows/CVI workspace or project',
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { 'LabWindows/CVI workspace or project': ['cws', 'prj'] }
    });
    if (files?.[0]) {
      await this.load(files[0].fsPath);
    }
  }

  async load(filePath: string): Promise<void> {
    const extension = path.extname(filePath).toLowerCase();
    if (extension !== '.cws' && extension !== '.prj') {
      throw new Error('Select a .cws workspace or a .prj project.');
    }
    this.workspace = extension === '.cws' ? this.parser.parseWorkspace(filePath) : this.parser.parseStandaloneProject(filePath);
    await this.context.workspaceState.update(LAST_WORKSPACE_KEY, filePath);
    this.output.appendLine(`[CVI] Loaded ${extension === '.cws' ? 'workspace' : 'project'}: ${filePath}`);
    this.changeEmitter.fire();
  }

  refresh(): void {
    if (!this.workspace) {
      this.changeEmitter.fire();
      return;
    }
    try {
      const currentPath = this.workspace.path;
      this.workspace = path.extname(currentPath).toLowerCase() === '.cws'
        ? this.parser.parseWorkspace(currentPath)
        : this.parser.parseStandaloneProject(currentPath);
    } catch (error) {
      this.output.appendLine(`[CVI] Refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.changeEmitter.fire();
  }

  async createWorkspaceProject(): Promise<void> {
    const folder = await vscode.window.showOpenDialog({
      title: 'Select the directory for the new CVI workspace',
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false
    });
    if (!folder?.[0]) {
      return;
    }

    const workspaceName = await vscode.window.showInputBox({
      title: 'Create a CVI workspace',
      prompt: 'Workspace file name without the .cws extension',
      value: 'CVI_Workspace',
      validateInput: validateBaseName
    });
    if (!workspaceName) {
      return;
    }

    const projectName = await vscode.window.showInputBox({
      title: 'Create a CVI project',
      prompt: 'Project file name without the .prj extension',
      value: 'CVI_Project',
      validateInput: validateBaseName
    });
    if (!projectName) {
      return;
    }

    const target = await vscode.window.showQuickPick([
      { label: 'Executable', value: 'Executable', description: 'Generate an .exe target' },
      { label: 'Dynamic Link Library', value: 'Dynamic Link Library', description: 'Generate a .dll target' },
      { label: 'Static Library', value: 'Static Library', description: 'Generate a .lib target' }
    ], { title: 'Select the CVI target type' });
    if (!target) {
      return;
    }

    let installation = this.installations.getActiveInstallation();
    if (!installation) {
      installation = await this.installations.selectInstallation();
    }
    const formatVersion = vscode.workspace.getConfiguration('labwindowsCvi').get<number>('projectFormatVersion', 1200);
    const result = this.parser.createWorkspaceAndProject(folder[0].fsPath, workspaceName, projectName, target.value, installation?.root, formatVersion);
    await this.load(result.workspacePath);
    vscode.window.showInformationMessage(`Created ${path.basename(result.workspacePath)} and ${path.basename(result.projectPath)}.`);
  }

  async setActiveProject(projectRef?: CviWorkspaceProjectRef): Promise<void> {
    const workspace = this.workspace;
    if (!workspace) {
      return;
    }

    let selected = projectRef;
    if (!selected) {
      const item = await vscode.window.showQuickPick(workspace.projects.map((project) => ({
        label: project.name,
        description: project.relativePath,
        project
      })), { title: 'Select the active CVI project' });
      selected = item?.project;
    }
    if (!selected) {
      return;
    }

    if (path.extname(workspace.path).toLowerCase() === '.cws') {
      this.parser.setWorkspaceActiveProject(workspace.path, selected.index);
    }
    workspace.activeProjectIndex = selected.index;
    this.refresh();
  }

  async addExistingProject(): Promise<void> {
    if (!this.workspace) {
      await this.openWorkspace();
      return;
    }
    const files = await vscode.window.showOpenDialog({
      title: 'Select a LabWindows/CVI project to add',
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { 'LabWindows/CVI project': ['prj'] }
    });
    if (!files?.[0]) {
      return;
    }
    this.parser.addProjectToWorkspace(this.workspace.path, files[0].fsPath);
    this.refresh();
  }

  async removeProject(projectRef: CviWorkspaceProjectRef): Promise<void> {
    if (!this.workspace) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Remove ${projectRef.name} from the current CVI workspace? The .prj file will not be deleted.`,
      { modal: true },
      'Remove'
    );
    if (answer !== 'Remove') {
      return;
    }
    this.parser.removeProjectFromWorkspace(this.workspace.path, projectRef.index);
    this.refresh();
  }

  async addFiles(projectRef?: CviWorkspaceProjectRef, folderOverride?: string): Promise<void> {
    const ref = projectRef ?? this.activeProjectRef;
    if (!ref?.exists) {
      vscode.window.showErrorMessage('No existing CVI project is selected.');
      return;
    }

    const files = await vscode.window.showOpenDialog({
      title: `Add files to ${ref.name}`,
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      filters: {
        'CVI project resources': ['c', 'h', 'uir', 'fp', 'lib', 'obj'],
        'All files': ['*']
      }
    });
    if (!files?.length) {
      return;
    }

    let folder = folderOverride;
    if (folder === undefined) {
      const inferredTypes = new Set(files.map((file) => inferType(file.fsPath)));
      const suggested = inferredTypes.size === 1 ? defaultFolderForType([...inferredTypes][0]) : '';
      folder = await vscode.window.showInputBox({
        title: 'CVI logical folder',
        prompt: 'Folder displayed in the CVI project tree. Nested folders can use /. Leave empty to use the default folder for each file type.',
        value: suggested
      });
      if (folder === undefined) {
        return;
      }
    }

    const count = this.parser.addFilesToProject(ref.absolutePath, files.map((file) => file.fsPath), folder || undefined);
    this.refresh();
    vscode.window.showInformationMessage(`${count} file(s) added to ${ref.name}.`);
  }

  async createNewFile(projectRef?: CviWorkspaceProjectRef, folderOverride?: string): Promise<void> {
    const ref = projectRef ?? this.activeProjectRef;
    if (!ref?.exists) {
      vscode.window.showErrorMessage('No existing CVI project is selected.');
      return;
    }

    const type = await vscode.window.showQuickPick([
      { label: 'C source file', extension: '.c', description: 'Create an empty C source file' },
      { label: 'C header file', extension: '.h', description: 'Create a guarded C header file' },
      { label: 'Text file', extension: '.txt', description: 'Create an empty text file' }
    ], { title: `Create a new file in ${ref.name}` });
    if (!type) {
      return;
    }

    const uri = await vscode.window.showSaveDialog({
      title: `Create ${type.label}`,
      defaultUri: vscode.Uri.file(path.join(path.dirname(ref.absolutePath), `new_file${type.extension}`)),
      filters: { [type.label]: [type.extension.slice(1)] }
    });
    if (!uri) {
      return;
    }

    let filePath = uri.fsPath;
    if (!path.extname(filePath)) {
      filePath += type.extension;
    }
    if (fs.existsSync(filePath)) {
      const answer = await vscode.window.showWarningMessage(`${path.basename(filePath)} already exists. Add the existing file to the CVI project?`, { modal: true }, 'Add existing file');
      if (answer !== 'Add existing file') {
        return;
      }
    } else {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, initialFileContents(filePath), 'utf8');
    }

    this.parser.addFilesToProject(ref.absolutePath, [filePath], folderOverride);
    this.refresh();
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(document);
  }

  async addFolder(projectRef?: CviWorkspaceProjectRef, parentFolder = ''): Promise<void> {
    const ref = projectRef ?? this.activeProjectRef;
    if (!ref?.exists) {
      vscode.window.showErrorMessage('No existing CVI project is selected.');
      return;
    }
    const prefix = normalizeLogicalFolder(parentFolder);
    const name = await vscode.window.showInputBox({
      title: `Add a CVI logical folder to ${ref.name}`,
      prompt: prefix ? `New child folder under ${prefix}` : 'New logical folder. Nested folders can use /.',
      validateInput: validateLogicalFolder
    });
    if (!name) {
      return;
    }
    const fullName = normalizeLogicalFolder([prefix, name].filter(Boolean).join('/'));
    this.parser.addFolderToProject(ref.absolutePath, fullName);
    this.refresh();
  }

  async renameFolder(projectRef: CviWorkspaceProjectRef, folderPath: string): Promise<void> {
    const current = normalizeLogicalFolder(folderPath);
    const parent = current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : '';
    const leaf = current.split('/').pop() ?? current;
    const name = await vscode.window.showInputBox({
      title: 'Rename CVI logical folder',
      prompt: parent ? `Rename ${leaf} under ${parent}` : `Rename ${leaf}`,
      value: leaf,
      validateInput: validateLogicalFolderLeaf
    });
    if (!name) {
      return;
    }
    this.parser.renameFolderInProject(projectRef.absolutePath, current, [parent, name].filter(Boolean).join('/'));
    this.refresh();
  }

  async removeFolder(projectRef: CviWorkspaceProjectRef, folderPath: string): Promise<void> {
    const answer = await vscode.window.showWarningMessage(
      `Remove the logical folder ${folderPath} from ${projectRef.name}? Files on disk will never be deleted.`,
      { modal: true },
      'Move contents to parent',
      'Remove file references'
    );
    if (!answer) {
      return;
    }
    this.parser.removeFolderFromProject(projectRef.absolutePath, folderPath, answer === 'Remove file references');
    this.refresh();
  }

  async removeFile(projectRef: CviWorkspaceProjectRef, sectionName: string, filePath: string): Promise<void> {
    const answer = await vscode.window.showWarningMessage(
      `Remove ${path.basename(filePath)} from ${projectRef.name}? The file will not be deleted from disk.`,
      { modal: true },
      'Remove'
    );
    if (answer !== 'Remove') {
      return;
    }
    this.parser.removeFileFromProject(projectRef.absolutePath, sectionName);
    this.refresh();
  }

  setFileExcluded(projectRef: CviWorkspaceProjectRef, file: CviProjectFile, excluded: boolean): void {
    this.parser.setFileExcluded(projectRef.absolutePath, file.sectionName, excluded);
    this.refresh();
  }

  toggleCompileIntoObjectFile(projectRef: CviWorkspaceProjectRef, file: CviProjectFile): void {
    this.parser.setCompileIntoObjectFile(projectRef.absolutePath, file.sectionName, !file.compileIntoObjectFile);
    this.refresh();
  }

  async replaceFile(projectRef: CviWorkspaceProjectRef, file: CviProjectFile): Promise<void> {
    const selected = await vscode.window.showOpenDialog({
      title: `Replace ${path.basename(file.absolutePath)} in ${projectRef.name}`,
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      defaultUri: vscode.Uri.file(path.dirname(file.absolutePath)),
      filters: { 'CVI project resources': ['c', 'h', 'uir', 'fp', 'lib', 'obj'], 'All files': ['*'] }
    });
    if (!selected?.[0]) {
      return;
    }
    this.parser.replaceFileInProject(projectRef.absolutePath, file.sectionName, selected[0].fsPath);
    this.refresh();
  }

  async saveFile(filePath: string): Promise<void> {
    const document = vscode.workspace.textDocuments.find((candidate) => path.normalize(candidate.uri.fsPath) === path.normalize(filePath));
    if (document?.isDirty) {
      await document.save();
    }
  }

  async openPath(filePath: string): Promise<void> {
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath));
  }

  async revealInExplorer(fileOrDirectoryPath: string): Promise<void> {
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(fileOrDirectoryPath));
  }

  async findInDirectory(directoryPath: string): Promise<void> {
    const uri = vscode.Uri.file(directoryPath);
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const relative = folder ? vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/') : undefined;
    const normalized = directoryPath.replace(/\\/g, '/');
    const filesToInclude = relative && relative !== '.' ? `${relative}/**` : folder ? '**' : `${normalized}/**`;
    await vscode.commands.executeCommand('workbench.action.findInFiles', { filesToInclude });
  }

  directoryForLogicalFolder(projectRef: CviWorkspaceProjectRef, folderPath: string): string {
    const project = this.getProject(projectRef);
    if (!project) {
      return path.dirname(projectRef.absolutePath);
    }
    const normalized = normalizeLogicalFolder(folderPath).toLowerCase();
    const files = project.files
      .filter((file) => {
        const candidate = normalizeLogicalFolder(file.folder).toLowerCase();
        return candidate === normalized || candidate.startsWith(`${normalized}/`);
      })
      .map((file) => path.dirname(file.absolutePath));
    return commonAncestor(files) ?? path.dirname(projectRef.absolutePath);
  }

  private findFilesAtLimitedDepth(directory: string, extension: string, depth: number): string[] {
    if (depth < 0 || !fs.existsSync(directory)) {
      return [];
    }
    const result: string[] = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') {
        continue;
      }
      const candidate = path.join(directory, entry.name);
      if (entry.isFile() && path.extname(entry.name).toLowerCase() === extension) {
        result.push(candidate);
      } else if (entry.isDirectory()) {
        result.push(...this.findFilesAtLimitedDepth(candidate, extension, depth - 1));
      }
    }
    return result;
  }
}

function validateBaseName(value: string): string | undefined {
  if (!value.trim()) {
    return 'A name is required.';
  }
  if (/[<>:"/\\|?*]/.test(value)) {
    return 'The name contains a character that is not permitted in a Windows file name.';
  }
  return undefined;
}

function validateLogicalFolder(value: string): string | undefined {
  if (!value.trim()) {
    return 'A folder name is required.';
  }
  if (/[<>:"\\|?*]/.test(value)) {
    return 'The logical folder contains an unsupported character.';
  }
  return undefined;
}

function validateLogicalFolderLeaf(value: string): string | undefined {
  const error = validateLogicalFolder(value);
  if (error) {
    return error;
  }
  if (value.includes('/')) {
    return 'Enter only the folder name, without a slash.';
  }
  return undefined;
}

function normalizeLogicalFolder(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/').trim();
}

function inferType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.c': return 'CSource';
    case '.h': return 'Include';
    case '.uir': return 'User Interface Resource';
    case '.fp': return 'Function Panel';
    case '.lib': return 'Library';
    default: return 'Other';
  }
}

function initialFileContents(filePath: string): string {
  if (path.extname(filePath).toLowerCase() !== '.h') {
    return '';
  }
  const guard = `${path.basename(filePath, path.extname(filePath)).replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}_H`;
  return `#ifndef ${guard}\r\n#define ${guard}\r\n\r\n#endif /* ${guard} */\r\n`;
}

function commonAncestor(paths: string[]): string | undefined {
  if (paths.length === 0) {
    return undefined;
  }
  const split = paths.map((candidate) => path.resolve(candidate).split(path.sep));
  const first = split[0];
  let length = first.length;
  for (const candidate of split.slice(1)) {
    length = Math.min(length, candidate.length);
    for (let index = 0; index < length; index += 1) {
      if (candidate[index].toLowerCase() !== first[index].toLowerCase()) {
        length = index;
        break;
      }
    }
  }
  return length > 0 ? first.slice(0, length).join(path.sep) || path.parse(paths[0]).root : undefined;
}
