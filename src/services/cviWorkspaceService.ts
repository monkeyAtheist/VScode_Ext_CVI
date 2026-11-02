import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CviParser, defaultFolderForType } from '../model/cviParser';
import { CviProject, CviProjectFile, CviWorkspace, CviWorkspaceProjectRef } from '../model/types';
import { CviInstallationService } from './cviInstallationService';
import { CviTemplateService } from './cviTemplateService';

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
    private readonly templates: CviTemplateService,
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
    if (extension === '.cws') {
      const issues = this.parser.inspectWorkspaceCompatibility(filePath);
      if (issues.length > 0) {
        this.output.appendLine('[CVI] Native workspace compatibility issues detected:');
        issues.forEach((issue) => this.output.appendLine(`  - ${issue}`));
        void vscode.window.showWarningMessage(
          `${path.basename(filePath)} contains ${issues.length} CVI workspace compatibility issue(s). Repair the native workspace before saving new run settings.`,
          'Repair workspace',
          'Ignore'
        ).then((answer) => answer === 'Repair workspace' ? this.repairNativeWorkspaceCompatibility() : undefined);
      }
    }
  }

  async repairNativeWorkspaceCompatibility(): Promise<void> {
    const workspace = this.workspace;
    if (!workspace || path.extname(workspace.path).toLowerCase() !== '.cws') {
      vscode.window.showErrorMessage('Open a .cws LabWindows/CVI workspace before running the compatibility repair.');
      return;
    }
    const result = this.parser.repairWorkspaceCompatibility(workspace.path);
    if (!result.changed) {
      vscode.window.showInformationMessage(`${path.basename(workspace.path)} does not require a native CVI compatibility repair.`);
      return;
    }
    this.output.appendLine(`[CVI] Native workspace compatibility repair applied to ${workspace.path}:`);
    result.changes.forEach((change) => this.output.appendLine(`  - ${change}`));
    this.refresh();
    vscode.window.showInformationMessage(`Repaired ${path.basename(workspace.path)}. A backup was stored in .vscode/cvi-native-backups.`);
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

  async createWorkspace(): Promise<void> {
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
      prompt: 'Workspace file name without the .cws extension. Projects can be created or added afterwards.',
      value: 'CVI_Workspace',
      validateInput: validateBaseName
    });
    if (!workspaceName) {
      return;
    }

    const installation = this.installations.getActiveInstallation();
    const formatVersion = vscode.workspace.getConfiguration('labwindowsCvi').get<number>('projectFormatVersion', 1200);
    const workspacePath = this.parser.createWorkspace(folder[0].fsPath, workspaceName, installation?.root, formatVersion);
    await this.load(workspacePath);
    vscode.window.showInformationMessage(`Created ${path.basename(workspacePath)}. Add or create projects from the workspace tree when needed.`);
  }

  /** Backward-compatible command kept for older keybindings and links. */
  async createWorkspaceProject(): Promise<void> {
    await this.createWorkspace();
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

  async createProjectInWorkspace(): Promise<void> {
    const workspace = this.workspace;
    if (!workspace || path.extname(workspace.path).toLowerCase() !== '.cws') {
      vscode.window.showErrorMessage('Open a .cws LabWindows/CVI workspace before creating an additional project.');
      return;
    }

    const workspaceDirectory = path.dirname(workspace.path);
    const folders = await vscode.window.showOpenDialog({
      title: 'Select the directory for the new CVI project',
      defaultUri: vscode.Uri.file(workspaceDirectory),
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false
    });
    if (!folders?.[0]) {
      return;
    }

    const projectName = await vscode.window.showInputBox({
      title: 'Create a CVI project in the current workspace',
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
    if (!installation && !workspace.cviDir) {
      installation = await this.installations.selectInstallation();
    }
    const formatVersion = vscode.workspace.getConfiguration('labwindowsCvi').get<number>('projectFormatVersion', 1200);
    const projectPath = this.parser.createProject(folders[0].fsPath, projectName, target.value, installation?.root ?? workspace.cviDir, formatVersion);
    const projectIndex = this.parser.addProjectToWorkspace(workspace.path, projectPath);
    this.parser.setWorkspaceActiveProject(workspace.path, projectIndex);
    this.refresh();
    vscode.window.showInformationMessage(`Created ${path.basename(projectPath)} and added it to ${path.basename(workspace.path)} as the active project.`);
  }

  async renameWorkspace(): Promise<void> {
    const workspace = this.workspace;
    if (!workspace) {
      return;
    }
    if (path.extname(workspace.path).toLowerCase() === '.prj') {
      const ref = this.activeProjectRef;
      if (ref) {
        await this.renameProject(ref);
      }
      return;
    }

    const currentPath = workspace.path;
    const currentName = path.basename(currentPath, path.extname(currentPath));
    const nextName = await vscode.window.showInputBox({
      title: 'Rename CVI workspace',
      prompt: 'Workspace file name without the .cws extension',
      value: currentName,
      validateInput: validateBaseName
    });
    if (!nextName || nextName === currentName) {
      return;
    }

    const nextPath = path.join(path.dirname(currentPath), `${nextName}.cws`);
    this.ensureRenameTargetAvailable(currentPath, nextPath);
    await this.saveDocumentIfOpen(currentPath);
    const originalText = fs.readFileSync(currentPath, 'utf8');

    try {
      await this.renamePathOnDisk(currentPath, nextPath);
      this.parser.updateWorkspacePathAfterRename(nextPath);
      await this.load(nextPath);
      vscode.window.showInformationMessage(`Workspace renamed to ${path.basename(nextPath)}.`);
    } catch (error) {
      await this.rollbackRenamedPath(currentPath, nextPath, originalText);
      throw error;
    }
  }

  async renameProject(projectRef: CviWorkspaceProjectRef): Promise<void> {
    if (!projectRef.exists || !fs.existsSync(projectRef.absolutePath)) {
      vscode.window.showErrorMessage('The selected CVI project file does not exist.');
      return;
    }

    const currentPath = projectRef.absolutePath;
    const currentName = path.basename(currentPath, path.extname(currentPath));
    const nextName = await vscode.window.showInputBox({
      title: 'Rename CVI project',
      prompt: 'Project file name without the .prj extension. Workspace references are updated automatically.',
      value: currentName,
      validateInput: validateBaseName
    });
    if (!nextName || nextName === currentName) {
      return;
    }

    const nextPath = path.join(path.dirname(currentPath), `${nextName}.prj`);
    this.ensureRenameTargetAvailable(currentPath, nextPath);
    await this.saveDocumentIfOpen(currentPath);

    const workspacePath = this.workspace?.path;
    const workspaceIsCws = Boolean(workspacePath && path.extname(workspacePath).toLowerCase() === '.cws');
    const originalProjectText = fs.readFileSync(currentPath, 'utf8');
    const originalWorkspaceText = workspaceIsCws && workspacePath ? fs.readFileSync(workspacePath, 'utf8') : undefined;

    try {
      await this.renamePathOnDisk(currentPath, nextPath);
      this.parser.updateProjectPathAfterRename(nextPath, currentPath);
      if (workspaceIsCws && workspacePath) {
        this.parser.updateWorkspaceProjectPath(workspacePath, projectRef.index, nextPath);
        this.parser.updateWorkspaceReferencedFilePath(workspacePath, currentPath, nextPath);
        await this.load(workspacePath);
      } else {
        await this.load(nextPath);
      }
      vscode.window.showInformationMessage(`Project renamed to ${path.basename(nextPath)}.`);
    } catch (error) {
      await this.rollbackRenamedPath(currentPath, nextPath, originalProjectText);
      if (workspaceIsCws && workspacePath && originalWorkspaceText !== undefined) {
        try { fs.writeFileSync(workspacePath, originalWorkspaceText, 'utf8'); } catch { /* best effort rollback */ }
      }
      throw error;
    }
  }

  async renameFile(projectRef: CviWorkspaceProjectRef, file: CviProjectFile): Promise<void> {
    const currentPath = file.absolutePath;
    if (!fs.existsSync(currentPath)) {
      vscode.window.showErrorMessage(`File not found: ${currentPath}`);
      return;
    }

    const currentName = path.basename(currentPath);
    const nextName = await vscode.window.showInputBox({
      title: 'Rename CVI project file',
      prompt: 'File name including extension. The .prj reference is updated automatically.',
      value: currentName,
      validateInput: validateFileName
    });
    if (!nextName || nextName === currentName) {
      return;
    }

    const nextPath = path.join(path.dirname(currentPath), nextName);
    this.ensureRenameTargetAvailable(currentPath, nextPath);
    await this.saveDocumentIfOpen(currentPath);
    const originalProjectText = fs.readFileSync(projectRef.absolutePath, 'utf8');
    const workspacePath = this.workspace?.path;
    const workspaceIsCws = Boolean(workspacePath && path.extname(workspacePath).toLowerCase() === '.cws');
    const originalWorkspaceText = workspaceIsCws && workspacePath ? fs.readFileSync(workspacePath, 'utf8') : undefined;

    try {
      await this.renamePathOnDisk(currentPath, nextPath);
      this.parser.replaceFileInProject(projectRef.absolutePath, file.sectionName, nextPath);
      if (workspaceIsCws && workspacePath) {
        this.parser.updateWorkspaceReferencedFilePath(workspacePath, currentPath, nextPath);
      }
      this.refresh();
      vscode.window.showInformationMessage(`${currentName} renamed to ${nextName}.`);
    } catch (error) {
      await this.rollbackRenamedPath(currentPath, nextPath);
      try { fs.writeFileSync(projectRef.absolutePath, originalProjectText, 'utf8'); } catch { /* best effort rollback */ }
      if (workspaceIsCws && workspacePath && originalWorkspaceText !== undefined) {
        try { fs.writeFileSync(workspacePath, originalWorkspaceText, 'utf8'); } catch { /* best effort rollback */ }
      }
      throw error;
    }
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

    const generated = await this.templates.generateNewFiles(path.dirname(ref.absolutePath));
    if (!generated) {
      return;
    }

    const added = this.parser.addFilesToProject(ref.absolutePath, generated.files, folderOverride);
    this.refresh();

    if (generated.primaryPath && fs.existsSync(generated.primaryPath) && path.extname(generated.primaryPath).toLowerCase() !== '.uir') {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(generated.primaryPath));
      await vscode.window.showTextDocument(document, { preview: false });
    }

    const summary = `${added} project reference(s) added. ${generated.createdFiles.length} file(s) written.`;
    if (generated.uirPath) {
      const action = await vscode.window.showInformationMessage(`${summary} The blank UIR resource is ready for graphical editing.`, 'Open panel in CVI');
      if (action === 'Open panel in CVI') {
        await vscode.commands.executeCommand('labwindowsCvi.openPanelPathInCvi', generated.uirPath);
      }
    } else {
      vscode.window.showInformationMessage(summary);
    }
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

  async deleteFile(projectRef: CviWorkspaceProjectRef, sectionName: string, filePath: string): Promise<void> {
    const resolvedFilePath = path.resolve(filePath);
    const resolvedProjectPath = path.resolve(projectRef.absolutePath);
    if (resolvedFilePath.toLowerCase() === resolvedProjectPath.toLowerCase()) {
      vscode.window.showErrorMessage('The CVI project file cannot be deleted through Delete File. Use the project actions instead.');
      return;
    }

    if (!fs.existsSync(resolvedFilePath)) {
      vscode.window.showWarningMessage(
        `${path.basename(filePath)} no longer exists on disk. Use Remove File to remove the stale reference from ${projectRef.name}.`
      );
      return;
    }

    const stat = fs.statSync(resolvedFilePath);
    if (!stat.isFile()) {
      vscode.window.showErrorMessage('Delete File can only delete regular files.');
      return;
    }

    const normalized = path.normalize(resolvedFilePath).toLowerCase();
    const dirtyDocument = vscode.workspace.textDocuments.find(
      (candidate) => path.normalize(candidate.uri.fsPath).toLowerCase() === normalized && candidate.isDirty
    );
    if (dirtyDocument) {
      vscode.window.showWarningMessage(
        `${path.basename(filePath)} has unsaved changes. Save or discard those changes before deleting the file.`
      );
      return;
    }

    const answer = await vscode.window.showWarningMessage(
      `Delete ${path.basename(filePath)} from disk and remove it from ${projectRef.name}?`,
      {
        modal: true,
        detail: `The file will be moved to the operating system Recycle Bin / Trash.\n\n${resolvedFilePath}\n\nUse Remove File instead if you only want to detach the file from the CVI project.`
      },
      'Delete File'
    );
    if (answer !== 'Delete File') {
      return;
    }

    const originalProjectContents = fs.readFileSync(projectRef.absolutePath, 'utf8');
    let projectReferenceRemoved = false;
    try {
      this.parser.removeFileFromProject(projectRef.absolutePath, sectionName);
      projectReferenceRemoved = true;
      await vscode.workspace.fs.delete(vscode.Uri.file(resolvedFilePath), { recursive: false, useTrash: true });
      this.refresh();
      vscode.window.showInformationMessage(`${path.basename(filePath)} was removed from ${projectRef.name} and moved to the Recycle Bin / Trash.`);
    } catch (error) {
      if (projectReferenceRemoved) {
        try {
          fs.writeFileSync(projectRef.absolutePath, originalProjectContents, 'utf8');
        } catch (rollbackError) {
          this.output.appendLine(`[CVI] Cannot restore ${projectRef.absolutePath} after file deletion failure: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      this.refresh();
      vscode.window.showErrorMessage(
        `Unable to delete ${path.basename(filePath)}. The CVI project reference was restored when possible: ${error instanceof Error ? error.message : String(error)}`
      );
    }
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

  async moveFileToFolder(projectRef: CviWorkspaceProjectRef, file: CviProjectFile): Promise<void> {
    const project = this.getProject(projectRef);
    if (!project) {
      vscode.window.showErrorMessage('The selected CVI project cannot be read.');
      return;
    }

    const currentFolder = normalizeLogicalFolder(file.folder);
    const folders = collectLogicalFolders(project);
    const items: Array<vscode.QuickPickItem & { targetFolder?: string; createNew?: boolean }> = [
      { label: '$(root-folder) Project root', description: 'No logical folder', targetFolder: '' },
      ...folders.map((folder) => ({ label: folder, description: folder.toLowerCase() === currentFolder.toLowerCase() ? 'current folder' : 'CVI logical folder', targetFolder: folder })),
      { label: '$(new-folder) Create new folder...', description: 'Create a CVI logical folder and move the file into it', createNew: true }
    ];

    const picked = await vscode.window.showQuickPick(items, {
      title: 'Move File To Folder',
      placeHolder: `Move ${path.basename(file.absolutePath)} to another CVI logical folder`
    });
    if (!picked) {
      return;
    }

    let targetFolder = picked.targetFolder ?? '';
    if (picked.createNew) {
      const name = await vscode.window.showInputBox({
        title: 'Create Target Folder',
        prompt: 'New CVI logical folder. Nested folders can use /.',
        validateInput: validateLogicalFolder
      });
      if (!name) {
        return;
      }
      targetFolder = normalizeLogicalFolder(name);
    }

    await this.moveFilesToFolder(projectRef, [file.sectionName], targetFolder);
  }

  async moveFilesToFolder(projectRef: CviWorkspaceProjectRef, sectionNames: string[], targetFolder: string, options: { silent?: boolean } = {}): Promise<void> {
    if (!projectRef.exists) {
      vscode.window.showErrorMessage('The selected CVI project file does not exist.');
      return;
    }

    const normalizedTarget = normalizeLogicalFolder(targetFolder);
    const moved = this.parser.moveFilesToFolderInProject(projectRef.absolutePath, sectionNames, normalizedTarget);
    if (moved === 0) {
      if (!options.silent) {
        vscode.window.showInformationMessage('The selected file is already in this CVI logical folder.');
      }
      return;
    }

    this.refresh();
    if (!options.silent) {
      const destination = normalizedTarget || 'project root';
      vscode.window.showInformationMessage(`${moved} file reference(s) moved to ${destination}.`);
    }
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

  async copyFilePath(filePath: string): Promise<void> {
    await vscode.env.clipboard.writeText(path.normalize(filePath));
  }

  async copyRelativeFilePath(projectRef: CviWorkspaceProjectRef, filePath: string): Promise<void> {
    const absolutePath = path.resolve(filePath);
    const uri = vscode.Uri.file(absolutePath);
    const vscodeFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (vscodeFolder) {
      await vscode.env.clipboard.writeText(relativeOrBasename(vscodeFolder.uri.fsPath, absolutePath));
      return;
    }

    const workspaceRoot = this.workspace ? path.dirname(this.workspace.path) : undefined;
    if (workspaceRoot && isPathInside(workspaceRoot, absolutePath)) {
      await vscode.env.clipboard.writeText(relativeOrBasename(workspaceRoot, absolutePath));
      return;
    }

    await vscode.env.clipboard.writeText(relativeOrBasename(path.dirname(projectRef.absolutePath), absolutePath));
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


  async selectTargetType(projectRef?: CviWorkspaceProjectRef): Promise<void> {
    const ref = projectRef ?? this.activeProjectRef;
    if (!ref?.exists) {
      vscode.window.showErrorMessage('No existing CVI project is selected.');
      return;
    }
    const project = this.getProject(ref);
    const selected = await vscode.window.showQuickPick([
      { label: 'Executable', value: 'Executable', description: 'Generate an .exe target' },
      { label: 'Dynamic Link Library', value: 'Dynamic Link Library', description: 'Generate a .dll target and import library' },
      { label: 'Static Library', value: 'Static Library', description: 'Generate a .lib target' }
    ], { title: `Select the CVI target type for ${ref.name}`, placeHolder: project?.targetType });
    if (!selected) {
      return;
    }
    this.parser.setTargetType(ref.absolutePath, selected.value);
    this.refresh();
    vscode.window.showInformationMessage(`${ref.name} target type: ${selected.label}.`);
  }

  async generatePrototypes(projectRef: CviWorkspaceProjectRef, file: CviProjectFile): Promise<void> {
    if (path.extname(file.absolutePath).toLowerCase() !== '.c') {
      vscode.window.showErrorMessage('Generate Prototypes is available only for C source files.');
      return;
    }
    if (!fs.existsSync(file.absolutePath)) {
      vscode.window.showErrorMessage(`Source file not found: ${file.absolutePath}`);
      return;
    }
    const headerPath = path.join(path.dirname(file.absolutePath), `${path.basename(file.absolutePath, '.c')}.h`);
    if (fs.existsSync(headerPath)) {
      const answer = await vscode.window.showWarningMessage(`${path.basename(headerPath)} already exists. Replace it with generated prototypes?`, { modal: true }, 'Replace');
      if (answer !== 'Replace') {
        return;
      }
    }
    const source = fs.readFileSync(file.absolutePath, 'utf8');
    const header = generatePrototypeHeader(source, path.basename(headerPath));
    fs.writeFileSync(headerPath, header, 'utf8');
    this.parser.addFilesToProject(projectRef.absolutePath, [headerPath]);
    this.refresh();
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(headerPath));
    await vscode.window.showTextDocument(document, { preview: false });
    vscode.window.showInformationMessage(`Generated ${path.basename(headerPath)}. Review the prototypes before using the header as a public API.`);
  }

  private ensureRenameTargetAvailable(currentPath: string, nextPath: string): void {
    if (path.resolve(currentPath) === path.resolve(nextPath)) {
      return;
    }
    const sameIgnoringCase = path.resolve(currentPath).toLowerCase() === path.resolve(nextPath).toLowerCase();
    if (!sameIgnoringCase && fs.existsSync(nextPath)) {
      throw new Error(`Cannot rename because the target already exists: ${nextPath}`);
    }
  }

  private async saveDocumentIfOpen(filePath: string): Promise<void> {
    const normalized = path.normalize(filePath).toLowerCase();
    const document = vscode.workspace.textDocuments.find((candidate) => path.normalize(candidate.uri.fsPath).toLowerCase() === normalized);
    if (document?.isDirty) {
      await document.save();
    }
  }

  private async renamePathOnDisk(currentPath: string, nextPath: string): Promise<void> {
    const currentResolved = path.resolve(currentPath);
    const nextResolved = path.resolve(nextPath);
    if (currentResolved === nextResolved) {
      return;
    }
    const caseOnlyRename = currentResolved.toLowerCase() === nextResolved.toLowerCase();
    if (!caseOnlyRename) {
      await vscode.workspace.fs.rename(vscode.Uri.file(currentPath), vscode.Uri.file(nextPath), { overwrite: false });
      return;
    }

    const temporaryPath = `${currentPath}.vscode-cvi-rename-${process.pid}-${Date.now()}`;
    await vscode.workspace.fs.rename(vscode.Uri.file(currentPath), vscode.Uri.file(temporaryPath), { overwrite: false });
    try {
      await vscode.workspace.fs.rename(vscode.Uri.file(temporaryPath), vscode.Uri.file(nextPath), { overwrite: false });
    } catch (error) {
      try { await vscode.workspace.fs.rename(vscode.Uri.file(temporaryPath), vscode.Uri.file(currentPath), { overwrite: false }); } catch { /* best effort rollback */ }
      throw error;
    }
  }

  private async rollbackRenamedPath(currentPath: string, nextPath: string, originalText?: string): Promise<void> {
    try {
      if (fs.existsSync(nextPath) && !fs.existsSync(currentPath)) {
        await this.renamePathOnDisk(nextPath, currentPath);
      }
      if (originalText !== undefined) {
        fs.writeFileSync(currentPath, originalText, 'utf8');
      }
    } catch (rollbackError) {
      this.output.appendLine(`[CVI] Rename rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
    }
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

function validateFileName(value: string): string | undefined {
  const error = validateBaseName(value);
  if (error) {
    return error;
  }
  if (value === '.' || value === '..') {
    return 'Enter a valid file name.';
  }
  return undefined;
}

function collectLogicalFolders(project: CviProject): string[] {
  const seen = new Set<string>();
  const addFolder = (value: string): void => {
    const normalized = normalizeLogicalFolder(value);
    if (normalized) {
      seen.add(normalized);
      let current = normalized;
      while (current.includes('/')) {
        current = current.slice(0, current.lastIndexOf('/'));
        if (current) {
          seen.add(current);
        }
      }
    }
  };

  for (const folder of project.folders) {
    addFolder(folder);
  }
  for (const file of project.files) {
    addFolder(file.folder);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
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


function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function relativeOrBasename(rootPath: string, filePath: string): string {
  return path.relative(path.resolve(rootPath), path.resolve(filePath)) || path.basename(filePath);
}

export function generatePrototypeHeader(source: string, headerName: string): string {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const pattern = /(^|\n)\s*((?:(?!\bstatic\b)[A-Za-z_][A-Za-z0-9_\s\*]*?))\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^;{}]*)\)\s*\{/g;
  const blocked = new Set(['if', 'for', 'while', 'switch', 'catch']);
  const prototypes: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stripped)) !== null) {
    const returnType = match[2].replace(/\s+/g, ' ').trim();
    const name = match[3];
    const parameters = match[4].replace(/\s+/g, ' ').trim();
    if (!returnType || blocked.has(name) || /\bstatic\b/.test(returnType)) {
      continue;
    }
    const prototype = `${returnType} ${name} (${parameters || 'void'});`;
    if (!prototypes.includes(prototype)) {
      prototypes.push(prototype);
    }
  }
  const guard = headerName.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
  const body = prototypes.length ? prototypes.join('\n') : '/* No non-static function definitions were detected automatically. */';
  return `#ifndef ${guard}\n#define ${guard}\n\n#ifdef __cplusplus\nextern "C" {\n#endif\n\n${body}\n\n#ifdef __cplusplus\n}\n#endif\n\n#endif /* ${guard} */\n`;
}
