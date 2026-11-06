import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CviParser, defaultFolderForType } from '../model/cviParser';
import { CviBuildMode, CviProject, CviProjectFile, CviWorkspace, CviWorkspaceProjectRef } from '../model/types';
import { CviInstallationService } from './cviInstallationService';
import { CviTemplateService } from './cviTemplateService';

const LAST_WORKSPACE_KEY = 'labwindowsCvi.lastWorkspace';

export interface CviProjectDependencyLifecycle {
  describeProjectRemoval(projectPath: string): string[];
  migrateProjectPath(oldProjectPath: string, newProjectPath: string): () => void;
  removeProject(projectPath: string): () => void;
}

export class CviWorkspaceService implements vscode.Disposable {
  private workspace: CviWorkspace | undefined;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly nativeFileWatchers: vscode.FileSystemWatcher[] = [];
  private nativeRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private nativeWatcherGeneration = 0;
  private disposed = false;
  private projectDependencyLifecycle: CviProjectDependencyLifecycle | undefined;

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
      vscode.workspace.onDidChangeWorkspaceFolders((event) => void this.handleWorkspaceFoldersChanged(event))
    );
  }

  dispose(): void {
    this.disposed = true;
    this.nativeWatcherGeneration += 1;
    if (this.nativeRefreshTimer) clearTimeout(this.nativeRefreshTimer);
    this.nativeRefreshTimer = undefined;
    for (const watcher of this.nativeFileWatchers.splice(0)) watcher.dispose();
    this.workspace = undefined;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.changeEmitter.dispose();
  }

  setProjectDependencyLifecycle(lifecycle: CviProjectDependencyLifecycle): void {
    this.projectDependencyLifecycle = lifecycle;
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

  getProjectBuildConfiguration(projectRef?: CviWorkspaceProjectRef): string | undefined {
    const workspace = this.workspace;
    const ref = projectRef ?? this.activeProjectRef;
    if (!workspace || !ref || path.extname(workspace.path).toLowerCase() !== '.cws') {
      return ref?.buildConfiguration;
    }
    const current = workspace.projects.find((candidate) => candidate.index === ref.index);
    return current?.buildConfiguration ?? this.parser.getWorkspaceProjectBuildConfiguration(workspace.path, ref.index);
  }

  getProjectBuildMode(projectRef?: CviWorkspaceProjectRef): CviBuildMode | undefined {
    const workspace = this.workspace;
    const ref = projectRef ?? this.activeProjectRef;
    if (!workspace || !ref || path.extname(workspace.path).toLowerCase() !== '.cws') {
      return undefined;
    }
    const current = workspace.projects.find((candidate) => candidate.index === ref.index);
    return current?.buildMode ?? this.parser.getWorkspaceProjectBuildMode(workspace.path, ref.index);
  }

  setProjectBuildConfiguration(projectRef: CviWorkspaceProjectRef, configurationName: string): void {
    const workspace = this.workspace;
    if (!workspace || path.extname(workspace.path).toLowerCase() !== '.cws') {
      return;
    }
    this.parser.setWorkspaceProjectBuildConfiguration(workspace.path, projectRef.index, configurationName);
    this.refresh();
  }

  setProjectBuildMode(projectRef: CviWorkspaceProjectRef, mode: CviBuildMode): void {
    const workspace = this.workspace;
    if (!workspace || path.extname(workspace.path).toLowerCase() !== '.cws') {
      return;
    }
    this.parser.setWorkspaceProjectBuildMode(workspace.path, projectRef.index, mode);
    this.refresh();
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
    if (this.disposed) return;
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
    if (this.disposed) return;
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
    if (this.disposed) return;
    const extension = path.extname(filePath).toLowerCase();
    if (extension !== '.cws' && extension !== '.prj') {
      throw new Error('Select a .cws workspace or a .prj project.');
    }
    this.workspace = extension === '.cws' ? this.parser.parseWorkspace(filePath) : this.parser.parseStandaloneProject(filePath);
    this.configureNativeFileWatchers();
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
    const projectIssues = this.workspace.projects
      .filter((project) => project.exists)
      .flatMap((project) => this.parser.inspectProjectCompatibility(project.absolutePath).map((issue) => `${project.name}: ${issue}`));
    if (projectIssues.length > 0) {
      this.output.appendLine('[CVI] Native project compatibility issues detected:');
      projectIssues.forEach((issue) => this.output.appendLine(`  - ${issue}`));
      void vscode.window.showWarningMessage(
        `${projectIssues.length} CVI project structural issue(s) detected. CVI-tolerated numbering, ordering and path variations are not treated as repairable errors.`,
        'Repair project files',
        'Ignore'
      ).then((answer) => answer === 'Repair project files' ? this.repairNativeWorkspaceCompatibility() : undefined);
    }
    const compatibility = this.collectNativeCompatibility();
    if (compatibility.notes.length > 0) {
      this.output.appendLine('[CVI] Native version/encoding compatibility profile:');
      compatibility.notes.forEach((note) => this.output.appendLine(`  - ${note}`));
    }
    if (compatibility.warnings.length > 0) {
      this.output.appendLine('[CVI] Native version/path compatibility warnings:');
      compatibility.warnings.forEach((warning) => this.output.appendLine(`  - ${warning}`));
      void vscode.window.showWarningMessage(
        `${compatibility.warnings.length} CVI native compatibility warning(s) detected (encoding/path/version).`,
        'Show details',
        'Ignore'
      ).then((answer) => { if (answer === 'Show details') this.output.show(true); });
    }
  }

  async validateNativeWorkspaceStructure(): Promise<void> {
    const workspace = this.workspace;
    if (!workspace) {
      vscode.window.showErrorMessage('Open a LabWindows/CVI workspace or project before running the structural validation.');
      return;
    }
    const issues: string[] = [];
    if (path.extname(workspace.path).toLowerCase() === '.cws') {
      issues.push(...this.parser.inspectWorkspaceCompatibility(workspace.path).map((issue) => `${path.basename(workspace.path)}: ${issue}`));
    }
    for (const project of workspace.projects) {
      if (!project.exists) {
        issues.push(`${project.name}: project file is missing: ${project.absolutePath}`);
        continue;
      }
      issues.push(...this.parser.inspectProjectCompatibility(project.absolutePath).map((issue) => `${project.name}: ${issue}`));
    }
    const compatibility = this.collectNativeCompatibility();
    this.output.appendLine(`[CVI] Structural validation: ${workspace.path}`);
    if (compatibility.notes.length > 0) {
      this.output.appendLine('  Compatibility profile:');
      compatibility.notes.forEach((note) => this.output.appendLine(`    - ${note}`));
    }
    if (compatibility.warnings.length > 0) {
      this.output.appendLine('  Compatibility warnings (not auto-repaired):');
      compatibility.warnings.forEach((warning) => this.output.appendLine(`    - ${warning}`));
    }
    if (issues.length === 0) {
      this.output.appendLine('  No structural issue detected.');
      if (compatibility.warnings.length > 0) {
        vscode.window.showWarningMessage(`CVI structure is valid, but ${compatibility.warnings.length} version/path compatibility warning(s) were detected. See LabWindows/CVI output.`);
      } else {
        vscode.window.showInformationMessage('CVI workspace/project structural validation passed: no issue detected.');
      }
      return;
    }
    issues.forEach((issue) => this.output.appendLine(`  - ${issue}`));
    const answer = await vscode.window.showWarningMessage(
      `CVI structural validation found ${issues.length} issue(s). See the LabWindows/CVI output for details.`,
      'Repair',
      'Close'
    );
    if (answer === 'Repair') await this.repairNativeWorkspaceCompatibility();
  }

  async repairNativeWorkspaceCompatibility(): Promise<void> {
    const workspace = this.workspace;
    if (!workspace) {
      vscode.window.showErrorMessage('Open a LabWindows/CVI workspace or project before running the compatibility repair.');
      return;
    }
    const nativeFiles = [
      ...(path.extname(workspace.path).toLowerCase() === '.cws' && fs.existsSync(workspace.path) ? [workspace.path] : []),
      ...workspace.projects.filter((candidate) => candidate.exists).map((candidate) => candidate.absolutePath)
    ];
    const originals = new Map<string, Buffer>();
    for (const filePath of nativeFiles) originals.set(filePath, fs.readFileSync(filePath));

    const changes: string[] = [];
    let changed = false;
    try {
      // Repair project files first so workspace memberships can be rebuilt from their final state.
      for (const project of workspace.projects.filter((candidate) => candidate.exists)) {
        const result = this.parser.repairProjectCompatibility(project.absolutePath);
        changed ||= result.changed;
        changes.push(...result.changes.map((change) => `${project.name}: ${change}`));
      }
      if (path.extname(workspace.path).toLowerCase() === '.cws') {
        const result = this.parser.repairWorkspaceCompatibility(workspace.path);
        changed ||= result.changed;
        changes.push(...result.changes.map((change) => `${path.basename(workspace.path)}: ${change}`));
      }
    } catch (error) {
      for (const [filePath, original] of originals) {
        try { fs.writeFileSync(filePath, original); } catch { /* best effort rollback */ }
      }
      this.output.appendLine(`[CVI] Native compatibility repair rolled back: ${error instanceof Error ? error.message : String(error)}`);
      vscode.window.showErrorMessage(`CVI structural repair failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`);
      this.refresh();
      return;
    }
    if (!changed) {
      vscode.window.showInformationMessage(`${path.basename(workspace.path)} and its project files do not require a native CVI compatibility repair.`);
      return;
    }
    this.output.appendLine(`[CVI] Native compatibility repair applied to ${workspace.path}:`);
    changes.forEach((change) => this.output.appendLine(`  - ${change}`));
    this.refresh();
    vscode.window.showInformationMessage(`Repaired ${changes.length} native CVI structural/compatibility item(s). Backups were stored in .vscode/cvi-native-backups.`);
  }

  private async confirmNativePathCompatibility(paths: string[], action: string): Promise<boolean> {
    const risks = [...new Set(paths.flatMap((candidate) => nativePathRiskMessages(candidate)))];
    if (risks.length === 0) return true;
    this.output.appendLine(`[CVI] Path compatibility warning before attempting to ${action}:`);
    risks.forEach((risk) => this.output.appendLine(`  - ${risk}`));
    const answer = await vscode.window.showWarningMessage(
      `The selected path(s) have ${risks.length} CVI compatibility risk(s), such as a path >= 260 characters or Unicode/code-page sensitivity. Continue anyway?`,
      { modal: true },
      'Continue anyway'
    );
    return answer === 'Continue anyway';
  }

  private collectNativeCompatibility(): { warnings: string[]; notes: string[] } {
    const workspace = this.workspace;
    if (!workspace) return { warnings: [], notes: [] };
    const nativeFiles = new Set<string>();
    if (fs.existsSync(workspace.path)) nativeFiles.add(workspace.path);
    for (const project of workspace.projects) {
      if (project.exists && fs.existsSync(project.absolutePath)) nativeFiles.add(project.absolutePath);
    }
    const warnings: string[] = [];
    const notes: string[] = [];
    for (const filePath of nativeFiles) {
      try {
        const report = this.parser.inspectNativeCompatibility(filePath);
        const prefix = path.basename(filePath);
        notes.push(...report.notes.map((note) => `${prefix}: ${note}`));
        warnings.push(...report.warnings.map((warning) => `${prefix}: ${warning}`));
      } catch (error) {
        warnings.push(`${path.basename(filePath)}: compatibility inspection failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { warnings: [...new Set(warnings)], notes: [...new Set(notes)] };
  }

  refresh(): void {
    if (this.disposed) return;
    if (!this.workspace) {
      this.changeEmitter.fire();
      return;
    }
    const currentPath = this.workspace.path;
    if (!fs.existsSync(currentPath)) {
      void this.unloadCurrentWorkspace(`native workspace/project disappeared from disk: ${currentPath}`, true);
      return;
    }
    try {
      this.workspace = path.extname(currentPath).toLowerCase() === '.cws'
        ? this.parser.parseWorkspace(currentPath)
        : this.parser.parseStandaloneProject(currentPath);
      this.configureNativeFileWatchers();
    } catch (error) {
      this.output.appendLine(`[CVI] Refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.changeEmitter.fire();
  }

  async closeWorkspace(): Promise<void> {
    await this.unloadCurrentWorkspace('closed by user', true);
  }

  private async handleWorkspaceFoldersChanged(event: vscode.WorkspaceFoldersChangeEvent): Promise<void> {
    if (this.disposed) return;
    const currentPath = this.workspace?.path;
    if (currentPath) {
      const removedOwner = event.removed.some((folder) => isPathInside(folder.uri.fsPath, currentPath));
      const stillOwned = (vscode.workspace.workspaceFolders ?? []).some((folder) => isPathInside(folder.uri.fsPath, currentPath));
      if (removedOwner && !stillOwned) {
        await this.unloadCurrentWorkspace('the owning VS Code workspace folder was removed', true);
      }
    }
    if (!this.workspace) {
      await this.autoLoad();
    }
  }

  private async unloadCurrentWorkspace(reason: string, forget: boolean): Promise<void> {
    const previous = this.workspace;
    if (!previous) return;
    this.workspace = undefined;
    this.nativeWatcherGeneration += 1;
    if (this.nativeRefreshTimer) clearTimeout(this.nativeRefreshTimer);
    this.nativeRefreshTimer = undefined;
    for (const watcher of this.nativeFileWatchers.splice(0)) watcher.dispose();
    if (forget && this.context.workspaceState.get<string>(LAST_WORKSPACE_KEY) === previous.path) {
      await this.context.workspaceState.update(LAST_WORKSPACE_KEY, undefined);
    }
    this.output.appendLine(`[CVI] Unloaded workspace/project ${previous.path}: ${reason}.`);
    if (!this.disposed) this.changeEmitter.fire();
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

    const candidateWorkspacePath = path.join(folder[0].fsPath, `${workspaceName}.cws`);
    if (!await this.confirmNativePathCompatibility([candidateWorkspacePath], 'create this CVI workspace')) return;
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
    if (!await this.confirmNativePathCompatibility([files[0].fsPath], 'add this project to the CVI workspace')) return;
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
    const candidateProjectPath = path.join(folders[0].fsPath, `${projectName}.prj`);
    if (!await this.confirmNativePathCompatibility([candidateProjectPath], 'create this CVI project')) return;
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
    if (!await this.confirmNativePathCompatibility([nextPath], 'rename this CVI workspace')) return;
    this.ensureRenameTargetAvailable(currentPath, nextPath);
    await this.saveDocumentIfOpen(currentPath);
    const originalText = fs.readFileSync(currentPath);

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
    if (!await this.confirmNativePathCompatibility([nextPath], 'rename this CVI project')) return;
    this.ensureRenameTargetAvailable(currentPath, nextPath);
    await this.saveDocumentIfOpen(currentPath);

    const workspacePath = this.workspace?.path;
    const workspaceIsCws = Boolean(workspacePath && path.extname(workspacePath).toLowerCase() === '.cws');
    const originalProjectText = fs.readFileSync(currentPath);
    const originalWorkspaceText = workspaceIsCws && workspacePath ? fs.readFileSync(workspacePath) : undefined;

    let rollbackDependencies: (() => void) | undefined;
    try {
      await this.renamePathOnDisk(currentPath, nextPath);
      this.parser.updateProjectPathAfterRename(nextPath, currentPath);
      if (workspaceIsCws && workspacePath) {
        this.parser.updateWorkspaceProjectPath(workspacePath, projectRef.index, nextPath);
        this.parser.updateWorkspaceReferencedFilePath(workspacePath, currentPath, nextPath);
      }
      rollbackDependencies = this.projectDependencyLifecycle?.migrateProjectPath(currentPath, nextPath);
      if (workspaceIsCws && workspacePath) {
        await this.load(workspacePath);
      } else {
        await this.load(nextPath);
      }
      vscode.window.showInformationMessage(`Project renamed to ${path.basename(nextPath)}.`);
    } catch (error) {
      try { rollbackDependencies?.(); } catch { /* best effort rollback */ }
      await this.rollbackRenamedPath(currentPath, nextPath, originalProjectText);
      if (workspaceIsCws && workspacePath && originalWorkspaceText !== undefined) {
        try { fs.writeFileSync(workspacePath, originalWorkspaceText); } catch { /* best effort rollback */ }
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
      prompt: 'File name including extension. All project references to the same physical file are updated automatically.',
      value: currentName,
      validateInput: validateFileName
    });
    if (!nextName || nextName === currentName) {
      return;
    }

    const nextPath = path.join(path.dirname(currentPath), nextName);
    if (!await this.confirmNativePathCompatibility([nextPath], 'rename this file used by CVI projects')) return;
    this.ensureRenameTargetAvailable(currentPath, nextPath);
    const references = this.findWorkspaceFileReferences(currentPath);
    if (references.length === 0) {
      references.push({ projectRef, sectionNames: [file.sectionName] });
    }
    const renameCollisions: string[] = [];
    for (const reference of references) {
      const project = this.getProject(reference.projectRef);
      if (!project) continue;
      for (const sectionName of reference.sectionNames) {
        const projectFile = project.files.find((candidate) => candidate.sectionName.toLowerCase() === sectionName.toLowerCase());
        if (!projectFile) continue;
        renameCollisions.push(...this.logicalNameCollisions(project, [{ filePath: nextPath, targetFolder: projectFile.folder, excludeSectionName: sectionName }]));
      }
    }
    if (renameCollisions.length > 0) {
      const answer = await vscode.window.showWarningMessage(
        `Renaming to ${nextName} creates a duplicate file name in at least one CVI logical folder.`,
        { modal: true, detail: [...new Set(renameCollisions)].join('\n') },
        'Rename Anyway'
      );
      if (answer !== 'Rename Anyway') return;
    }

    if (references.length > 1) {
      const projectList = references.map((reference) => `• ${reference.projectRef.name}`).join('\n');
      const answer = await vscode.window.showWarningMessage(
        `${currentName} is referenced by ${references.length} CVI projects. Rename the physical file and update every project reference?`,
        {
          modal: true,
          detail: `${projectList}\n\nNo project will keep the old file path.`
        },
        'Rename in All Projects'
      );
      if (answer !== 'Rename in All Projects') {
        return;
      }
    }

    await this.saveDocumentIfOpen(currentPath);
    for (const reference of references) {
      await this.saveDocumentIfOpen(reference.projectRef.absolutePath);
    }
    const workspacePath = this.workspace?.path;
    const workspaceIsCws = Boolean(workspacePath && path.extname(workspacePath).toLowerCase() === '.cws');
    if (workspaceIsCws && workspacePath) {
      await this.saveDocumentIfOpen(workspacePath);
    }
    const originalProjectTexts = new Map<string, Buffer>();
    for (const reference of references) {
      if (!originalProjectTexts.has(reference.projectRef.absolutePath)) {
        originalProjectTexts.set(reference.projectRef.absolutePath, fs.readFileSync(reference.projectRef.absolutePath));
      }
    }
    const originalWorkspaceText = workspaceIsCws && workspacePath ? fs.readFileSync(workspacePath) : undefined;
    const writtenProjects = new Map<string, Buffer>();
    let writtenWorkspace: Buffer | undefined;

    try {
      await this.renamePathOnDisk(currentPath, nextPath);
      for (const reference of references) {
        for (const sectionName of reference.sectionNames) {
          this.parser.replaceFileInProject(reference.projectRef.absolutePath, sectionName, nextPath);
        }
        writtenProjects.set(reference.projectRef.absolutePath, fs.readFileSync(reference.projectRef.absolutePath));
      }
      if (workspaceIsCws && workspacePath) {
        this.parser.updateWorkspaceReferencedFilePath(workspacePath, currentPath, nextPath);
        writtenWorkspace = fs.readFileSync(workspacePath);
      }
      this.refresh();
      const suffix = references.length > 1 ? ` in ${references.length} projects` : '';
      vscode.window.showInformationMessage(`${currentName} renamed to ${nextName}${suffix}.`);
    } catch (error) {
      await this.rollbackRenamedPath(currentPath, nextPath);
      for (const [projectPath, originalText] of originalProjectTexts) {
        this.restoreBufferIfOwned(projectPath, writtenProjects.get(projectPath), originalText);
      }
      if (workspaceIsCws && workspacePath && originalWorkspaceText !== undefined) {
        this.restoreBufferIfOwned(workspacePath, writtenWorkspace, originalWorkspaceText);
      }
      this.refresh();
      throw error;
    }
  }

  async removeProject(projectRef: CviWorkspaceProjectRef): Promise<void> {
    if (!this.workspace) {
      return;
    }
    const dependents = this.projectDependencyLifecycle?.describeProjectRemoval(projectRef.absolutePath) ?? [];
    const dependencyWarning = dependents.length
      ? `\n\nBuild dependency links from ${dependents.join(', ')} will also be removed.`
      : '';
    const answer = await vscode.window.showWarningMessage(
      `Remove ${projectRef.name} from the current CVI workspace? The .prj file will not be deleted.${dependencyWarning}`,
      { modal: true },
      'Remove'
    );
    if (answer !== 'Remove') {
      return;
    }

    const workspacePath = this.workspace.path;
    const originalWorkspaceText = fs.readFileSync(workspacePath);
    let rollbackDependencies: (() => void) | undefined;
    try {
      rollbackDependencies = this.projectDependencyLifecycle?.removeProject(projectRef.absolutePath);
      this.parser.removeProjectFromWorkspace(workspacePath, projectRef.index);
      this.refresh();
    } catch (error) {
      try { rollbackDependencies?.(); } catch { /* best effort rollback */ }
      try { fs.writeFileSync(workspacePath, originalWorkspaceText); } catch { /* best effort rollback */ }
      this.refresh();
      throw error;
    }
  }

  async addFiles(projectRef?: CviWorkspaceProjectRef, folderOverride?: string): Promise<void> {
    const ref = projectRef ?? this.activeProjectRef;
    if (!ref?.exists || !fs.existsSync(ref.absolutePath)) {
      vscode.window.showErrorMessage('No accessible CVI project is selected. The project may have been moved or its drive/network location may be unavailable.');
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
    if (!files?.length) return;
    const selectedPaths = files.map((file) => file.fsPath);
    if (!await this.confirmNativePathCompatibility(selectedPaths, 'add these files to the CVI project')) return;

    let folder = folderOverride;
    if (folder === undefined) {
      const inferredTypes = new Set(files.map((file) => inferType(file.fsPath)));
      const defaultFolder = inferredTypes.size === 1 ? defaultFolderForType([...inferredTypes][0]) : '';
      const suggested = defaultFolder === 'Not In A Folder' ? '' : defaultFolder;
      folder = await vscode.window.showInputBox({
        title: 'CVI logical folder',
        prompt: 'Single-level folder displayed in the CVI project tree. Leave empty to use the native CVI default for each file type. Physical files are not moved.',
        value: suggested,
        validateInput: (value) => value.trim() ? validateLogicalFolder(value) : undefined
      });
      if (folder === undefined) return;
    }

    const project = this.getProject(ref);
    if (!project) {
      vscode.window.showErrorMessage(`Cannot read ${ref.name}. Refresh the workspace and verify the project location.`);
      return;
    }
    const collisions = this.logicalNameCollisions(project, selectedPaths.map((filePath) => ({
      filePath,
      targetFolder: this.targetFolderForAddedFile(filePath, folder || undefined)
    })));
    if (collisions.length > 0) {
      const answer = await vscode.window.showWarningMessage(
        `${collisions.length} file-name collision(s) will appear in the same CVI logical folder.`,
        { modal: true, detail: `${collisions.join('\n')}

The files have different physical paths, but identical names in the CVI tree can be ambiguous and may also produce build-output collisions.` },
        'Add Anyway'
      );
      if (answer !== 'Add Anyway') return;
    }

    const projectDirectory = path.dirname(ref.absolutePath);
    const external = selectedPaths.filter((candidate) => !isPathInside(projectDirectory, candidate));
    if (external.length > 0) {
      this.output.appendLine(`[CVI] Adding ${external.length} external file reference(s) to ${ref.name}; files remain at their original physical location.`);
    }
    const existing = new Set(project.files.map((candidate) => path.normalize(path.resolve(candidate.absolutePath)).toLowerCase()));
    const alreadyReferenced = selectedPaths.filter((candidate) => existing.has(path.normalize(path.resolve(candidate)).toLowerCase())).length;

    await this.saveDocumentIfOpen(ref.absolutePath);
    const workspacePath = this.workspace?.path;
    const workspaceIsCws = Boolean(workspacePath && path.extname(workspacePath).toLowerCase() === '.cws' && fs.existsSync(workspacePath));
    if (workspaceIsCws && workspacePath) await this.saveDocumentIfOpen(workspacePath);
    const originalProject = fs.readFileSync(ref.absolutePath);
    const originalWorkspace = workspaceIsCws && workspacePath ? fs.readFileSync(workspacePath) : undefined;
    let writtenProject: Buffer | undefined;
    let writtenWorkspace: Buffer | undefined;
    try {
      const count = this.parser.addFilesToProject(ref.absolutePath, selectedPaths, folder || undefined);
      writtenProject = fs.readFileSync(ref.absolutePath);
      if (workspaceIsCws && workspacePath) {
        for (const candidate of selectedPaths) {
          const indexes = this.findWorkspaceFileReferences(candidate).map((reference) => reference.projectRef.index);
          this.parser.updateWorkspaceReferencedFileMemberships(workspacePath, candidate, indexes);
          writtenWorkspace = fs.readFileSync(workspacePath);
        }
      }
      this.refresh();
      const skipped = alreadyReferenced > 0 ? ` ${alreadyReferenced} already-referenced file(s) were skipped.` : '';
      vscode.window.showInformationMessage(`${count} file(s) added to ${ref.name}.${skipped}`);
    } catch (error) {
      this.restoreBufferIfOwned(ref.absolutePath, writtenProject, originalProject);
      if (workspacePath && originalWorkspace) this.restoreBufferIfOwned(workspacePath, writtenWorkspace, originalWorkspace);
      this.refresh();
      throw error;
    }
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
    if (normalizeLogicalFolder(parentFolder)) {
      vscode.window.showInformationMessage('LabWindows/CVI logical folders are single-level. Create the new folder from the project root.');
      return;
    }
    const name = await vscode.window.showInputBox({
      title: `Add a CVI logical folder to ${ref.name}`,
      prompt: 'New single-level CVI logical folder.',
      validateInput: validateLogicalFolder
    });
    if (!name) {
      return;
    }
    const normalizedName = normalizeLogicalFolder(name);
    const project = this.getProject(ref);
    if (project && collectLogicalFolders(project).some((folder) => folder.toLowerCase() === normalizedName.toLowerCase())) {
      vscode.window.showInformationMessage(`The CVI logical folder ${normalizedName} already exists in ${ref.name}.`);
      return;
    }
    this.parser.addFolderToProject(ref.absolutePath, normalizedName);
    this.refresh();
  }

  async renameFolder(projectRef: CviWorkspaceProjectRef, folderPath: string): Promise<void> {
    const current = normalizeLogicalFolder(folderPath);
    const name = await vscode.window.showInputBox({
      title: 'Rename CVI logical folder',
      prompt: `Rename ${current}`,
      value: current.replace(/[\\/]+/g, ' - '),
      validateInput: validateLogicalFolder
    });
    if (!name) {
      return;
    }
    const target = normalizeLogicalFolder(name);
    const project = this.getProject(projectRef);
    if (project && target.toLowerCase() !== current.toLowerCase()
      && collectLogicalFolders(project).some((folder) => folder.toLowerCase() === target.toLowerCase())) {
      const answer = await vscode.window.showWarningMessage(
        `The CVI logical folder ${target} already exists. Merge ${current} into it?`,
        { modal: true, detail: 'Only CVI project metadata is changed. Physical files and directories on disk are not moved.' },
        'Merge Folders'
      );
      if (answer !== 'Merge Folders') return;
    }
    this.parser.renameFolderInProject(projectRef.absolutePath, current, target);
    this.refresh();
  }

  async removeFolder(projectRef: CviWorkspaceProjectRef, folderPath: string): Promise<void> {
    const project = this.getProject(projectRef);
    if (!project) {
      vscode.window.showErrorMessage('The selected CVI project cannot be read.');
      return;
    }
    const normalizedFolder = normalizeLogicalFolder(folderPath);
    const affectedFiles = project.files.filter((file) => normalizeLogicalFolder(file.folder).toLowerCase() === normalizedFolder.toLowerCase());
    const answer = await vscode.window.showWarningMessage(
      `Remove the logical folder ${folderPath} from ${projectRef.name}? Files on disk will never be deleted.`,
      { modal: true, detail: `${affectedFiles.length} project file reference(s) are currently assigned to this logical folder.` },
      'Move contents to project root',
      'Remove file references'
    );
    if (!answer) return;

    const removeReferences = answer === 'Remove file references';
    await this.saveDocumentIfOpen(projectRef.absolutePath);
    const workspacePath = this.workspace?.path;
    const workspaceIsCws = Boolean(workspacePath && path.extname(workspacePath).toLowerCase() === '.cws' && fs.existsSync(workspacePath));
    if (workspaceIsCws && workspacePath) await this.saveDocumentIfOpen(workspacePath);
    const originalProject = fs.readFileSync(projectRef.absolutePath);
    const originalWorkspace = workspaceIsCws && workspacePath ? fs.readFileSync(workspacePath) : undefined;
    let writtenProject: Buffer | undefined;
    let writtenWorkspace: Buffer | undefined;
    try {
      this.parser.removeFolderFromProject(projectRef.absolutePath, folderPath, removeReferences);
      writtenProject = fs.readFileSync(projectRef.absolutePath);
      if (removeReferences && workspaceIsCws && workspacePath) {
        for (const file of affectedFiles) {
          const remainingIndexes = this.findWorkspaceFileReferences(file.absolutePath).map((reference) => reference.projectRef.index);
          this.parser.updateWorkspaceReferencedFileMemberships(workspacePath, file.absolutePath, remainingIndexes);
          writtenWorkspace = fs.readFileSync(workspacePath);
        }
      }
      this.refresh();
    } catch (error) {
      this.restoreBufferIfOwned(projectRef.absolutePath, writtenProject, originalProject);
      if (workspacePath && originalWorkspace) this.restoreBufferIfOwned(workspacePath, writtenWorkspace, originalWorkspace);
      this.refresh();
      throw error;
    }
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
    const workspacePath = this.workspace?.path;
    const workspaceIsCws = Boolean(workspacePath && path.extname(workspacePath).toLowerCase() === '.cws');
    await this.saveDocumentIfOpen(projectRef.absolutePath);
    if (workspaceIsCws && workspacePath) {
      await this.saveDocumentIfOpen(workspacePath);
    }
    const originalProjectText = fs.readFileSync(projectRef.absolutePath);
    const originalWorkspaceText = workspaceIsCws && workspacePath ? fs.readFileSync(workspacePath) : undefined;
    let writtenProject: Buffer | undefined;
    let writtenWorkspace: Buffer | undefined;
    try {
      this.parser.removeFileFromProject(projectRef.absolutePath, sectionName);
      writtenProject = fs.readFileSync(projectRef.absolutePath);
      if (workspaceIsCws && workspacePath) {
        const remainingIndexes = this.findWorkspaceFileReferences(filePath).map((reference) => reference.projectRef.index);
        this.parser.updateWorkspaceReferencedFileMemberships(workspacePath, filePath, remainingIndexes);
        writtenWorkspace = fs.readFileSync(workspacePath);
      }
      this.refresh();
    } catch (error) {
      this.restoreBufferIfOwned(projectRef.absolutePath, writtenProject, originalProjectText);
      if (workspaceIsCws && workspacePath && originalWorkspaceText !== undefined) {
        this.restoreBufferIfOwned(workspacePath, writtenWorkspace, originalWorkspaceText);
      }
      this.refresh();
      throw error;
    }
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

    const references = this.findWorkspaceFileReferences(resolvedFilePath);
    if (references.length === 0) {
      references.push({ projectRef, sectionNames: [sectionName] });
    }
    const shared = references.length > 1;
    const projectList = references.map((reference) => `• ${reference.projectRef.name}`).join('\n');
    const actionLabel = shared ? 'Delete from Disk and All Projects' : 'Delete File';
    const answer = await vscode.window.showWarningMessage(
      shared
        ? `Delete ${path.basename(filePath)} from disk? It is referenced by ${references.length} CVI projects.`
        : `Delete ${path.basename(filePath)} from disk and remove it from ${projectRef.name}?`,
      {
        modal: true,
        detail: shared
          ? `${projectList}\n\nThe file will be removed from every listed project, then moved to the operating system Recycle Bin / Trash.\n\n${resolvedFilePath}\n\nUse Remove File instead if you only want to detach it from one project.`
          : `The file will be moved to the operating system Recycle Bin / Trash.\n\n${resolvedFilePath}\n\nUse Remove File instead if you only want to detach the file from the CVI project.`
      },
      actionLabel
    );
    if (answer !== actionLabel) {
      return;
    }

    for (const reference of references) {
      await this.saveDocumentIfOpen(reference.projectRef.absolutePath);
    }
    const workspacePath = this.workspace?.path;
    const workspaceIsCws = Boolean(workspacePath && path.extname(workspacePath).toLowerCase() === '.cws');
    if (workspaceIsCws && workspacePath) {
      await this.saveDocumentIfOpen(workspacePath);
    }
    const originalProjectContents = new Map<string, Buffer>();
    for (const reference of references) {
      if (!originalProjectContents.has(reference.projectRef.absolutePath)) {
        originalProjectContents.set(reference.projectRef.absolutePath, fs.readFileSync(reference.projectRef.absolutePath));
      }
    }
    const originalWorkspaceText = workspaceIsCws && workspacePath ? fs.readFileSync(workspacePath) : undefined;
    const writtenProjects = new Map<string, Buffer>();
    let writtenWorkspace: Buffer | undefined;
    try {
      for (const reference of references) {
        // Structural validation guarantees one physical file reference per project.
        // Work from the current section name so removal/renumbering cannot invalidate a later operation.
        const currentProject = this.parser.parseProject(reference.projectRef.absolutePath);
        const currentEntry = currentProject.files.find((candidate) => path.normalize(path.resolve(candidate.absolutePath)).toLowerCase() === normalized);
        if (currentEntry) this.parser.removeFileFromProject(reference.projectRef.absolutePath, currentEntry.sectionName);
        writtenProjects.set(reference.projectRef.absolutePath, fs.readFileSync(reference.projectRef.absolutePath));
      }
      if (workspaceIsCws && workspacePath) {
        this.parser.removeWorkspaceReferencedFile(workspacePath, resolvedFilePath);
        writtenWorkspace = fs.readFileSync(workspacePath);
      }
      await vscode.workspace.fs.delete(vscode.Uri.file(resolvedFilePath), { recursive: false, useTrash: true });
      this.refresh();
      const suffix = shared ? `all ${references.length} CVI projects` : projectRef.name;
      vscode.window.showInformationMessage(`${path.basename(filePath)} was removed from ${suffix} and moved to the Recycle Bin / Trash.`);
    } catch (error) {
      for (const [projectPath, originalText] of originalProjectContents) {
        this.restoreBufferIfOwned(projectPath, writtenProjects.get(projectPath), originalText);
      }
      if (workspaceIsCws && workspacePath && originalWorkspaceText !== undefined) {
        this.restoreBufferIfOwned(workspacePath, writtenWorkspace, originalWorkspaceText);
      }
      this.refresh();
      vscode.window.showErrorMessage(
        `Unable to delete ${path.basename(filePath)}. CVI Project Manager rolled back only files that were still unchanged since its own write, so newer external CVI edits are never overwritten: ${error instanceof Error ? error.message : String(error)}`
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
    if (!selected?.[0]) return;
    const replacementPath = selected[0].fsPath;
    if (!await this.confirmNativePathCompatibility([replacementPath], 'replace this CVI project file reference')) return;
    if (path.normalize(path.resolve(replacementPath)).toLowerCase() === path.normalize(path.resolve(file.absolutePath)).toLowerCase()) {
      vscode.window.showInformationMessage('The selected file is already the current project reference.');
      return;
    }

    const project = this.getProject(projectRef);
    if (!project) {
      vscode.window.showErrorMessage('The selected CVI project cannot be read.');
      return;
    }
    const collisions = this.logicalNameCollisions(project, [{
      filePath: replacementPath,
      targetFolder: file.folder,
      excludeSectionName: file.sectionName
    }]);
    if (collisions.length > 0) {
      const answer = await vscode.window.showWarningMessage(
        `Replacing this reference creates a duplicate file name in the same CVI logical folder.`,
        { modal: true, detail: collisions.join('\n') },
        'Replace Anyway'
      );
      if (answer !== 'Replace Anyway') return;
    }

    await this.saveDocumentIfOpen(projectRef.absolutePath);
    const workspacePath = this.workspace?.path;
    const workspaceIsCws = Boolean(workspacePath && path.extname(workspacePath).toLowerCase() === '.cws' && fs.existsSync(workspacePath));
    if (workspaceIsCws && workspacePath) await this.saveDocumentIfOpen(workspacePath);
    const originalProject = fs.readFileSync(projectRef.absolutePath);
    const originalWorkspace = workspaceIsCws && workspacePath ? fs.readFileSync(workspacePath) : undefined;
    let writtenProject: Buffer | undefined;
    let writtenWorkspace: Buffer | undefined;
    try {
      this.parser.replaceFileInProject(projectRef.absolutePath, file.sectionName, replacementPath);
      writtenProject = fs.readFileSync(projectRef.absolutePath);
      if (workspaceIsCws && workspacePath) {
        const oldIndexes = this.findWorkspaceFileReferences(file.absolutePath).map((reference) => reference.projectRef.index);
        this.parser.updateWorkspaceReferencedFileMemberships(workspacePath, file.absolutePath, oldIndexes);
        writtenWorkspace = fs.readFileSync(workspacePath);
        const newIndexes = this.findWorkspaceFileReferences(replacementPath).map((reference) => reference.projectRef.index);
        this.parser.updateWorkspaceReferencedFileMemberships(workspacePath, replacementPath, newIndexes);
        writtenWorkspace = fs.readFileSync(workspacePath);
      }
      this.refresh();
      vscode.window.showInformationMessage(`${path.basename(file.absolutePath)} replaced by ${path.basename(replacementPath)} in ${projectRef.name}.`);
    } catch (error) {
      this.restoreBufferIfOwned(projectRef.absolutePath, writtenProject, originalProject);
      if (workspacePath && originalWorkspace) this.restoreBufferIfOwned(workspacePath, writtenWorkspace, originalWorkspace);
      this.refresh();
      throw error;
    }
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
      { label: '$(root-folder) Project root', description: 'No logical folder; physical file is not moved', targetFolder: '' },
      ...folders.map((folder) => ({ label: folder, description: folder.toLowerCase() === currentFolder.toLowerCase() ? 'current logical folder' : 'CVI logical folder; physical file is not moved', targetFolder: folder })),
      { label: '$(new-folder) Create new folder...', description: 'Create a CVI logical folder; physical file is not moved', createNew: true }
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
        prompt: 'New single-level CVI logical folder.',
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
    if (!projectRef.exists || !fs.existsSync(projectRef.absolutePath)) {
      vscode.window.showErrorMessage('The selected CVI project file does not exist or its location is unavailable.');
      return;
    }

    const normalizedTarget = normalizeLogicalFolder(targetFolder);
    const project = this.getProject(projectRef);
    if (!project) {
      vscode.window.showErrorMessage('The selected CVI project cannot be read.');
      return;
    }
    const selectedSet = new Set(sectionNames.map((name) => name.toLowerCase()));
    const movingFiles = project.files.filter((file) => selectedSet.has(file.sectionName.toLowerCase()));
    const collisions = this.logicalNameCollisions(project, movingFiles.map((file) => ({
      filePath: file.absolutePath,
      targetFolder: normalizedTarget,
      excludeSectionName: file.sectionName
    })));
    // Ignore collision pairs where both entries are in the same selected move set; add explicit pair check below.
    const selectedPairCollisions: string[] = [];
    for (let left = 0; left < movingFiles.length; left += 1) {
      for (let right = left + 1; right < movingFiles.length; right += 1) {
        if (path.basename(movingFiles[left].absolutePath).toLowerCase() === path.basename(movingFiles[right].absolutePath).toLowerCase()
          && path.normalize(path.resolve(movingFiles[left].absolutePath)).toLowerCase() !== path.normalize(path.resolve(movingFiles[right].absolutePath)).toLowerCase()) {
          selectedPairCollisions.push(`${path.basename(movingFiles[left].absolutePath)}: ${movingFiles[left].absolutePath} ↔ ${movingFiles[right].absolutePath}`);
        }
      }
    }
    const allCollisions = [...new Set([...collisions, ...selectedPairCollisions])];
    if (allCollisions.length > 0) {
      const answer = await vscode.window.showWarningMessage(
        `${allCollisions.length} file-name collision(s) will exist in the target CVI logical folder.`,
        { modal: true, detail: `${allCollisions.join('\n')}

This operation changes only CVI logical-folder metadata; physical files stay where they are.` },
        'Move Anyway'
      );
      if (answer !== 'Move Anyway') return;
    }

    const moved = this.parser.moveFilesToFolderInProject(projectRef.absolutePath, sectionNames, normalizedTarget);
    if (moved === 0) {
      if (!options.silent) vscode.window.showInformationMessage('The selected file is already in this CVI logical folder.');
      return;
    }

    this.refresh();
    if (!options.silent) {
      const destination = normalizedTarget || 'project root';
      vscode.window.showInformationMessage(`${moved} file reference(s) moved to ${destination}. Physical files were not moved.`);
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

  private logicalNameCollisions(
    project: CviProject,
    candidates: Array<{ filePath: string; targetFolder: string; excludeSectionName?: string }>
  ): string[] {
    const collisions: string[] = [];
    const normalizedFolder = (value: string): string => {
      const normalized = normalizeLogicalFolder(value);
      return normalized.toLowerCase() === 'not in a folder' ? '' : normalized.toLowerCase();
    };
    for (const candidate of candidates) {
      const candidatePath = path.normalize(path.resolve(candidate.filePath)).toLowerCase();
      const candidateName = path.basename(candidate.filePath).toLowerCase();
      const folder = normalizedFolder(candidate.targetFolder);
      for (const existing of project.files) {
        if (candidate.excludeSectionName && existing.sectionName.toLowerCase() === candidate.excludeSectionName.toLowerCase()) continue;
        if (path.normalize(path.resolve(existing.absolutePath)).toLowerCase() === candidatePath) continue;
        if (path.basename(existing.absolutePath).toLowerCase() === candidateName && normalizedFolder(existing.folder) === folder) {
          collisions.push(`${path.basename(candidate.filePath)}: ${existing.absolutePath} ↔ ${candidate.filePath}`);
        }
      }
    }
    for (let left = 0; left < candidates.length; left += 1) {
      for (let right = left + 1; right < candidates.length; right += 1) {
        const a = candidates[left];
        const b = candidates[right];
        if (path.normalize(path.resolve(a.filePath)).toLowerCase() === path.normalize(path.resolve(b.filePath)).toLowerCase()) continue;
        if (path.basename(a.filePath).toLowerCase() === path.basename(b.filePath).toLowerCase()
          && normalizedFolder(a.targetFolder) === normalizedFolder(b.targetFolder)) {
          collisions.push(`${path.basename(a.filePath)}: ${a.filePath} ↔ ${b.filePath}`);
        }
      }
    }
    return [...new Set(collisions)];
  }

  private targetFolderForAddedFile(filePath: string, folderOverride?: string): string {
    if (folderOverride?.trim()) return normalizeLogicalFolder(folderOverride);
    const nativeDefault = defaultFolderForType(inferType(filePath));
    return nativeDefault.toLowerCase() === 'not in a folder' ? '' : normalizeLogicalFolder(nativeDefault);
  }

  private findWorkspaceFileReferences(filePath: string): Array<{ projectRef: CviWorkspaceProjectRef; sectionNames: string[] }> {
    const workspace = this.workspace;
    if (!workspace) {
      return [];
    }
    const target = path.normalize(path.resolve(filePath)).toLowerCase();
    const references: Array<{ projectRef: CviWorkspaceProjectRef; sectionNames: string[] }> = [];
    for (const projectRef of workspace.projects) {
      if (!projectRef.exists || !fs.existsSync(projectRef.absolutePath)) {
        continue;
      }
      try {
        const project = this.parser.parseProject(projectRef.absolutePath);
        const sectionNames = project.files
          .filter((candidate) => path.normalize(path.resolve(candidate.absolutePath)).toLowerCase() === target)
          .map((candidate) => candidate.sectionName);
        if (sectionNames.length > 0) {
          references.push({ projectRef, sectionNames });
        }
      } catch (error) {
        this.output.appendLine(`[CVI] Cannot inspect shared file references in ${projectRef.absolutePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return references;
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

  private async rollbackRenamedPath(currentPath: string, nextPath: string, originalText?: Buffer): Promise<void> {
    try {
      if (fs.existsSync(nextPath) && !fs.existsSync(currentPath)) {
        await this.renamePathOnDisk(nextPath, currentPath);
      }
      if (originalText !== undefined) {
        fs.writeFileSync(currentPath, originalText);
      }
    } catch (rollbackError) {
      this.output.appendLine(`[CVI] Rename rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
    }
  }

  private configureNativeFileWatchers(): void {
    this.nativeWatcherGeneration += 1;
    const generation = this.nativeWatcherGeneration;
    if (this.nativeRefreshTimer) clearTimeout(this.nativeRefreshTimer);
    this.nativeRefreshTimer = undefined;
    for (const watcher of this.nativeFileWatchers.splice(0)) watcher.dispose();
    const workspace = this.workspace;
    if (!workspace || this.disposed) return;
    const nativeFiles = new Set<string>([workspace.path, ...workspace.projects.map((project) => project.absolutePath)]);
    for (const filePath of nativeFiles) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(path.dirname(filePath), path.basename(filePath)),
        false, false, false
      );
      const schedule = (): void => this.scheduleNativeFileRefresh(filePath, generation);
      watcher.onDidChange(schedule);
      watcher.onDidCreate(schedule);
      watcher.onDidDelete(schedule);
      this.nativeFileWatchers.push(watcher);
    }
  }

  private scheduleNativeFileRefresh(filePath: string, generation: number): void {
    if (this.disposed || generation !== this.nativeWatcherGeneration) return;
    if (this.nativeRefreshTimer) clearTimeout(this.nativeRefreshTimer);
    this.nativeRefreshTimer = setTimeout(() => {
      this.nativeRefreshTimer = undefined;
      if (this.disposed || generation !== this.nativeWatcherGeneration) return;
      this.output.appendLine(`[CVI] Native project/workspace changed on disk: ${filePath}. Refreshing the VS Code tree.`);
      this.refresh();
    }, 150);
  }

  private restoreBufferIfOwned(filePath: string, expectedCurrent: Buffer | undefined, original: Buffer): boolean {
    if (!expectedCurrent) return false;
    try {
      const current = fs.readFileSync(filePath);
      if (!current.equals(expectedCurrent)) {
        this.output.appendLine(`[CVI] Rollback skipped for ${filePath}: the file changed again after CVI Project Manager wrote it.`);
        return false;
      }
      fs.writeFileSync(filePath, original);
      return true;
    } catch (error) {
      this.output.appendLine(`[CVI] Rollback failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
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

function nativePathRiskMessages(candidate: string): string[] {
  const value = path.normalize(candidate);
  const risks: string[] = [];
  if (value.length >= 260) risks.push(`${value.length}-character path exceeds or reaches the traditional Windows MAX_PATH boundary: ${value}`);
  if (value.normalize('NFC') !== value) risks.push(`Path contains decomposed Unicode characters that native CVI may reject: ${value}`);
  if (/[^\x00-\x7f]/.test(value)) risks.push(`Path contains non-ASCII characters and must be representable by the Windows System Codepage used by CVI: ${value}`);
  return risks;
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
    if (normalized && normalized.toLowerCase() !== 'not in a folder') {
      seen.add(normalized);
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
  if (/[\\/]/.test(value)) {
    return 'LabWindows/CVI logical folders are single-level; / and \\ are not supported.';
  }
  if (/[<>:"|?*]/.test(value)) {
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
    default: return 'Unknown';
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
