import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CviParser } from '../model/cviParser';
import { CviInstallation, CviWorkspace } from '../model/types';
import { CviInstallationService } from './cviInstallationService';

const MANAGED_CONFIGURATION_NAME = 'LabWindows/CVI (managed)';
const CPPTOOLS_EXTENSION_ID = 'ms-vscode.cpptools';
const CVI_CONFIGURATION_PROVIDER_ID = 'jc-tools.labwindows-cvi-project-manager';

interface CppPropertiesDocument {
  version?: number;
  enableConfigurationSquiggles?: boolean;
  configurations?: CppToolsConfiguration[];
  [key: string]: unknown;
}

interface CppToolsConfiguration {
  name?: string;
  compilerPath?: string;
  configurationProvider?: string;
  mergeConfigurations?: boolean;
  intelliSenseMode?: string;
  cStandard?: string;
  cppStandard?: string;
  includePath?: string[];
  browse?: {
    path?: string[];
    limitSymbolsToIncludedHeaders?: boolean;
    [key: string]: unknown;
  };
  defines?: string[];
  [key: string]: unknown;
}

interface SourceFileConfiguration {
  includePath: string[];
  defines: string[];
  intelliSenseMode?: string;
  standard?: string;
  compilerPath?: string;
}

interface SourceFileConfigurationItem {
  uri: vscode.Uri;
  configuration: SourceFileConfiguration;
}

interface WorkspaceBrowseConfiguration {
  browsePath: string[];
  compilerPath?: string;
  standard?: string;
}

interface CustomConfigurationProviderLike extends vscode.Disposable {
  readonly name: string;
  readonly extensionId: string;
  canProvideConfiguration(uri: vscode.Uri, token?: vscode.CancellationToken): Thenable<boolean>;
  provideConfigurations(uris: vscode.Uri[], token?: vscode.CancellationToken): Thenable<SourceFileConfigurationItem[]>;
  canProvideBrowseConfiguration(token?: vscode.CancellationToken): Thenable<boolean>;
  provideBrowseConfiguration(token?: vscode.CancellationToken): Thenable<WorkspaceBrowseConfiguration | null>;
}

interface CppToolsApiLike extends vscode.Disposable {
  registerCustomConfigurationProvider(provider: CustomConfigurationProviderLike): void;
  notifyReady(provider: CustomConfigurationProviderLike): void;
  didChangeCustomConfiguration(provider: CustomConfigurationProviderLike): void;
  didChangeCustomBrowseConfiguration(provider: CustomConfigurationProviderLike): void;
}

interface ProviderPaths {
  includePath: string[];
  browsePath: string[];
  compilerPath?: string;
}

export class CviCppToolsService implements vscode.Disposable {
  private syncTimer: NodeJS.Timeout | undefined;
  private currentWorkspace: CviWorkspace | undefined;
  private cppToolsApi: CppToolsApiLike | undefined;
  private providerRegistered = false;
  private cachedProviderPaths: { key: string; value: ProviderPaths } | undefined;

  private readonly provider: CustomConfigurationProviderLike = {
    name: 'LabWindows/CVI Project Manager',
    extensionId: CVI_CONFIGURATION_PROVIDER_ID,
    canProvideConfiguration: async (uri: vscode.Uri) => this.canProvideConfiguration(uri),
    provideConfigurations: async (uris: vscode.Uri[]) => this.provideConfigurations(uris),
    canProvideBrowseConfiguration: async () => !!this.currentWorkspace,
    provideBrowseConfiguration: async () => this.provideBrowseConfiguration(),
    dispose: () => undefined
  };

  constructor(
    private readonly installations: CviInstallationService,
    private readonly parser: CviParser,
    private readonly output: vscode.OutputChannel
  ) {}

  dispose(): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = undefined;
    }
    this.provider.dispose();
    this.cppToolsApi?.dispose();
    this.cppToolsApi = undefined;
  }

  async initializeProvider(): Promise<void> {
    if (this.providerRegistered) {
      return;
    }

    const enabled = vscode.workspace.getConfiguration('labwindowsCvi').get<boolean>('useCppToolsConfigurationProvider', true);
    if (!enabled) {
      this.output.appendLine('[CVI] Dynamic C/C++ IntelliSense provider disabled by settings.');
      return;
    }

    const extension = vscode.extensions.getExtension<any>(CPPTOOLS_EXTENSION_ID);
    if (!extension) {
      this.output.appendLine('[CVI] Microsoft C/C++ extension not detected. The generated c_cpp_properties.json file remains available as a fallback.');
      return;
    }

    try {
      const exported = await extension.activate();
      const api = typeof exported?.getApi === 'function' ? exported.getApi(1) : exported;
      if (!api || typeof api.registerCustomConfigurationProvider !== 'function' || typeof api.notifyReady !== 'function') {
        this.output.appendLine('[CVI] Microsoft C/C++ extension detected, but its custom configuration provider API is unavailable.');
        return;
      }
      this.cppToolsApi = api as CppToolsApiLike;
      this.cppToolsApi.registerCustomConfigurationProvider(this.provider);
      this.cppToolsApi.notifyReady(this.provider);
      this.providerRegistered = true;
      this.output.appendLine('[CVI] Registered the LabWindows/CVI dynamic IntelliSense configuration provider.');
    } catch (error) {
      this.output.appendLine(`[CVI] Cannot register the dynamic IntelliSense provider: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  requestSync(workspace: CviWorkspace | undefined): void {
    this.setCurrentWorkspace(workspace);
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined;
      void this.sync(workspace);
    }, 120);
  }

  async sync(workspace: CviWorkspace | undefined, notify = false): Promise<string | undefined> {
    this.setCurrentWorkspace(workspace);
    await this.initializeProvider();

    if (!workspace) {
      if (notify) {
        vscode.window.showErrorMessage('Open a LabWindows/CVI workspace or project before synchronizing IntelliSense.');
      }
      return undefined;
    }

    const enabled = vscode.workspace.getConfiguration('labwindowsCvi').get<boolean>('autoConfigureCppTools', true);
    if (!enabled && !notify) {
      return undefined;
    }

    const installation = this.installations.getActiveInstallation(workspace.cviDir);
    if (!installation) {
      if (notify) {
        vscode.window.showErrorMessage('No LabWindows/CVI installation is selected. Select an installation before synchronizing IntelliSense.');
      }
      return undefined;
    }

    const root = this.findConfigurationRoot(workspace.path);
    const configPath = path.join(root, '.vscode', 'c_cpp_properties.json');
    const configuration = this.createManagedConfiguration(installation, workspace);
    const document = this.readExistingDocument(configPath);
    if (!document) {
      return undefined;
    }

    const configurations = Array.isArray(document.configurations) ? [...document.configurations] : [];
    const previousIndex = configurations.findIndex((candidate) => candidate?.name === MANAGED_CONFIGURATION_NAME);
    if (previousIndex >= 0) {
      configurations[previousIndex] = configuration;
    } else {
      configurations.unshift(configuration);
    }

    const updated: CppPropertiesDocument = {
      ...document,
      version: 4,
      enableConfigurationSquiggles: true,
      configurations
    };
    const rendered = `${JSON.stringify(updated, null, 2)}\n`;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });

    const previous = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : undefined;
    if (previous !== rendered) {
      fs.writeFileSync(configPath, rendered, 'utf8');
      this.output.appendLine(`[CVI] Synchronized C/C++ IntelliSense configuration: ${configPath}`);
    }

    this.notifyProviderChanged();

    const owningFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(workspace.path));
    if (!owningFolder) {
      this.output.appendLine(`[CVI] IntelliSense configuration was written outside the currently opened VS Code folders: ${configPath}`);
      if (notify) {
        const action = await vscode.window.showWarningMessage(
          `The CVI workspace is outside the folders currently opened in VS Code. The dynamic provider is available, but adding ${root} as a VS Code folder also activates the generated .vscode/c_cpp_properties.json file.`,
          'Add CVI folder to workspace'
        );
        if (action === 'Add CVI folder to workspace') {
          await this.addConfigurationRootToWorkspace(workspace);
        }
      }
      return configPath;
    }

    if (notify) {
      vscode.window.showInformationMessage(`LabWindows/CVI IntelliSense configuration synchronized in ${configPath}.`);
    }
    return configPath;
  }

  async ensureConfigurationRootInWorkspace(workspace: CviWorkspace | undefined = this.currentWorkspace, notify = false): Promise<boolean> {
    if (!workspace) {
      return false;
    }
    const enabled = vscode.workspace.getConfiguration('labwindowsCvi').get<boolean>('autoAddCviFolderToWorkspace', true);
    if (!enabled) {
      return false;
    }

    const root = this.findConfigurationRoot(workspace.path, false);
    const rootUri = vscode.Uri.file(root);
    const owningFolder = vscode.workspace.getWorkspaceFolder(rootUri);
    if (owningFolder) {
      return false;
    }

    const currentFolders = vscode.workspace.workspaceFolders ?? [];
    const added = vscode.workspace.updateWorkspaceFolders(currentFolders.length, 0, { uri: rootUri, name: path.basename(root) });
    if (!added) {
      this.output.appendLine(`[CVI] VS Code could not add ${root} to the standard Explorer automatically.`);
      if (notify) {
        vscode.window.showWarningMessage(`VS Code could not add ${root} to the current workspace automatically. Open this directory manually.`);
      }
      return false;
    }

    this.output.appendLine(`[CVI] Added the CVI folder to the standard VS Code Explorer: ${root}`);
    if (notify) {
      vscode.window.showInformationMessage(`Added ${root} to the standard VS Code Explorer.`);
    }
    return true;
  }

  async addConfigurationRootToWorkspace(workspace: CviWorkspace | undefined = this.currentWorkspace): Promise<void> {
    if (!workspace) {
      vscode.window.showErrorMessage('Open a LabWindows/CVI workspace or project first.');
      return;
    }
    const root = this.findConfigurationRoot(workspace.path, false);
    const rootUri = vscode.Uri.file(root);
    const alreadyOpen = !!vscode.workspace.getWorkspaceFolder(rootUri);
    if (!alreadyOpen) {
      const currentFolders = vscode.workspace.workspaceFolders ?? [];
      const added = vscode.workspace.updateWorkspaceFolders(currentFolders.length, 0, { uri: rootUri, name: path.basename(root) });
      if (!added) {
        vscode.window.showWarningMessage(`VS Code could not add ${root} to the current workspace automatically. Open this directory manually.`);
        return;
      }
      this.output.appendLine(`[CVI] Added the CVI folder to the standard VS Code Explorer: ${root}`);
    }
    await this.sync(workspace, false);
    vscode.window.showInformationMessage(alreadyOpen
      ? `${root} is already available in the standard VS Code Explorer.`
      : `Added ${root} to the standard VS Code Explorer for CVI IntelliSense.`);
  }

  async diagnose(workspace: CviWorkspace | undefined = this.currentWorkspace): Promise<void> {
    this.setCurrentWorkspace(workspace);
    await this.initializeProvider();

    this.output.appendLine('');
    this.output.appendLine('========== LabWindows/CVI IntelliSense diagnostic ==========');
    if (!workspace) {
      this.output.appendLine('[CVI] No CVI workspace is currently loaded.');
      this.output.show(true);
      vscode.window.showErrorMessage('No CVI workspace is currently loaded. Open a .cws or .prj file first.');
      return;
    }

    const installation = this.installations.getActiveInstallation(workspace.cviDir);
    const root = this.findConfigurationRoot(workspace.path);
    const owningFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(workspace.path));
    this.output.appendLine(`[CVI] Workspace: ${workspace.path}`);
    this.output.appendLine(`[CVI] Configuration root: ${root}`);
    this.output.appendLine(`[CVI] Configuration root is active in VS Code: ${owningFolder ? 'yes' : 'no'}`);
    this.output.appendLine(`[CVI] Dynamic provider registered: ${this.providerRegistered ? 'yes' : 'no'}`);
    this.output.appendLine(`[CVI] Microsoft C/C++ extension detected: ${vscode.extensions.getExtension(CPPTOOLS_EXTENSION_ID) ? 'yes' : 'no'}`);

    if (!installation) {
      this.output.appendLine('[CVI] No active CVI installation detected.');
      this.output.show(true);
      vscode.window.showWarningMessage('No active CVI installation detected. Select a CVI installation and synchronize IntelliSense.');
      return;
    }

    const includeRoot = path.join(installation.root, 'include');
    const toolboxRoot = path.join(installation.root, 'toolslib', 'toolbox');
    const toolboxHeader = path.join(toolboxRoot, 'toolbox.h');
    const compilerPath = this.resolveCompilerPath(installation);
    this.output.appendLine(`[CVI] Active installation: ${installation.root}`);
    this.output.appendLine(`[CVI] CVI include directory exists: ${fs.existsSync(includeRoot) ? 'yes' : 'no'} · ${includeRoot}`);
    this.output.appendLine(`[CVI] Toolbox directory exists: ${fs.existsSync(toolboxRoot) ? 'yes' : 'no'} · ${toolboxRoot}`);
    this.output.appendLine(`[CVI] toolbox.h exists: ${fs.existsSync(toolboxHeader) ? 'yes' : 'no'} · ${toolboxHeader}`);
    this.output.appendLine(`[CVI] IntelliSense compiler: ${compilerPath ?? 'not detected; explicit include paths will be used'}`);
    const ansiHeaderCandidates = findHeaderCandidates(includeRoot, ['ansi.h', 'ansi_c.h'], 5, 600);
    const windowsHeaderCandidates = findWindowsHeaderCandidates();
    this.output.appendLine(`[CVI] ANSI header candidates: ${ansiHeaderCandidates.length ? ansiHeaderCandidates.join(' · ') : 'not found under the selected CVI include directory'}`);
    this.output.appendLine(`[CVI] windows.h candidates: ${windowsHeaderCandidates.length ? windowsHeaderCandidates.join(' · ') : 'not found in detected Windows SDK directories'}`);

    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (activeFile) {
      this.output.appendLine(`[CVI] Active editor file: ${activeFile}`);
      this.output.appendLine(`[CVI] Dynamic provider accepts active file: ${this.canProvideConfiguration(vscode.Uri.file(activeFile)) ? 'yes' : 'no'}`);
    }

    const paths = this.getProviderPaths(workspace, installation);
    this.output.appendLine(`[CVI] Provider include directories: ${paths.includePath.length}`);
    for (const includePath of paths.includePath) {
      this.output.appendLine(`  - ${includePath}`);
    }
    this.output.appendLine('=============================================================');
    this.output.show(true);

    const missingToolbox = !fs.existsSync(toolboxHeader);
    const message = missingToolbox
      ? 'The selected CVI installation does not expose toolslib/toolbox/toolbox.h. Select the correct installation directory.'
      : 'CVI IntelliSense diagnostic complete. The LabWindows/CVI output channel contains the details.';
    const action = await vscode.window.showInformationMessage(message, 'Synchronize now');
    if (action === 'Synchronize now') {
      await this.sync(workspace, true);
    }
  }

  private setCurrentWorkspace(workspace: CviWorkspace | undefined): void {
    if (this.currentWorkspace?.path !== workspace?.path) {
      this.cachedProviderPaths = undefined;
    }
    this.currentWorkspace = workspace;
    this.notifyProviderChanged();
  }

  private notifyProviderChanged(): void {
    if (!this.providerRegistered || !this.cppToolsApi) {
      return;
    }
    try {
      this.cppToolsApi.didChangeCustomConfiguration(this.provider);
      this.cppToolsApi.didChangeCustomBrowseConfiguration(this.provider);
    } catch (error) {
      this.output.appendLine(`[CVI] Cannot notify the C/C++ extension about updated CVI paths: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private canProvideConfiguration(uri: vscode.Uri): boolean {
    const workspace = this.currentWorkspace;
    if (!workspace || uri.scheme !== 'file') {
      return false;
    }
    const extension = path.extname(uri.fsPath).toLowerCase();
    if (!['.c', '.h', '.cpp', '.hpp', '.cc', '.cxx'].includes(extension)) {
      return false;
    }
    const candidate = path.resolve(uri.fsPath);
    const workspaceDirectory = path.dirname(workspace.path);
    if (isPathInside(candidate, workspaceDirectory)) {
      return true;
    }
    for (const project of workspace.projects) {
      if (project.exists && isPathInside(candidate, path.dirname(project.absolutePath))) {
        return true;
      }
    }
    const installation = this.installations.getActiveInstallation(workspace.cviDir);
    return !!installation && isPathInside(candidate, installation.root);
  }

  private provideConfigurations(uris: vscode.Uri[]): SourceFileConfigurationItem[] {
    const workspace = this.currentWorkspace;
    if (!workspace) {
      return [];
    }
    const installation = this.installations.getActiveInstallation(workspace.cviDir);
    if (!installation) {
      return [];
    }
    const paths = this.getProviderPaths(workspace, installation);
    return uris.filter((uri) => this.canProvideConfiguration(uri)).map((uri) => ({
      uri,
      configuration: {
        includePath: paths.includePath,
        defines: defaultDefines(),
        intelliSenseMode: 'windows-clang-x86',
        standard: isCppFile(uri.fsPath) ? 'c++17' : 'c11',
        ...(paths.compilerPath ? { compilerPath: paths.compilerPath } : {})
      }
    }));
  }

  private provideBrowseConfiguration(): WorkspaceBrowseConfiguration | null {
    const workspace = this.currentWorkspace;
    if (!workspace) {
      return null;
    }
    const installation = this.installations.getActiveInstallation(workspace.cviDir);
    if (!installation) {
      return null;
    }
    const paths = this.getProviderPaths(workspace, installation);
    return {
      browsePath: paths.browsePath,
      standard: 'c11',
      ...(paths.compilerPath ? { compilerPath: paths.compilerPath } : {})
    };
  }

  private getProviderPaths(workspace: CviWorkspace, installation: CviInstallation): ProviderPaths {
    const additional = this.getAdditionalIncludePaths();
    const key = JSON.stringify({ workspace: workspace.path, installation: installation.root, additional });
    if (this.cachedProviderPaths?.key === key) {
      return this.cachedProviderPaths.value;
    }

    const projectDirectories = this.collectProjectDirectories(workspace);
    const includeRoot = path.join(installation.root, 'include');
    const toolsLibraryRoot = path.join(installation.root, 'toolslib');
    const toolboxRoot = path.join(toolsLibraryRoot, 'toolbox');
    const windowsKitRoots = findWindowsKitIncludeDirectories();
    const ansiHeaderDirectories = findHeaderCandidates(includeRoot, ['ansi.h', 'ansi_c.h'], 5, 600).map((header) => path.dirname(header));
    const includePath = unique([
      ...projectDirectories,
      includeRoot,
      path.join(includeRoot, 'ansi'),
      ...ansiHeaderDirectories,
      ...collectHeaderDirectories(includeRoot, 5, 600),
      ...collectHeaderDirectories(toolsLibraryRoot, 7, 900),
      ...windowsKitRoots.flatMap((directory) => collectHeaderDirectories(directory, 3, 300)),
      ...additional
    ].filter((entry) => fs.existsSync(entry)).map(toForwardSlashes));
    const browsePath = unique([
      ...projectDirectories,
      includeRoot,
      path.join(includeRoot, 'ansi'),
      ...ansiHeaderDirectories,
      toolsLibraryRoot,
      toolboxRoot,
      ...windowsKitRoots,
      ...additional
    ].filter((entry) => fs.existsSync(entry)).map(toForwardSlashes));
    const value: ProviderPaths = {
      includePath,
      browsePath,
      compilerPath: this.resolveCompilerPath(installation)
    };
    this.cachedProviderPaths = { key, value };
    return value;
  }

  private collectProjectDirectories(workspace: CviWorkspace): string[] {
    const directories = [path.dirname(workspace.path)];
    for (const projectRef of workspace.projects) {
      if (!projectRef.exists) {
        continue;
      }
      directories.push(path.dirname(projectRef.absolutePath));
      try {
        const project = this.parser.parseProject(projectRef.absolutePath);
        for (const file of project.files) {
          directories.push(path.dirname(file.absolutePath));
        }
      } catch (error) {
        this.output.appendLine(`[CVI] Cannot collect IntelliSense paths from ${projectRef.absolutePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return unique(directories.filter((entry) => fs.existsSync(entry)).map(toForwardSlashes));
  }

  private resolveCompilerPath(installation: CviInstallation): string | undefined {
    const override = vscode.workspace.getConfiguration('labwindowsCvi').get<string>('intelliSenseCompilerPath', '').trim();
    if (override) {
      if (fs.existsSync(override)) {
        return toForwardSlashes(path.normalize(override));
      }
      this.output.appendLine(`[CVI] Configured IntelliSense compiler path does not exist: ${override}`);
    }
    return installation.clangCcExe && fs.existsSync(installation.clangCcExe)
      ? toForwardSlashes(installation.clangCcExe)
      : undefined;
  }

  private getAdditionalIncludePaths(): string[] {
    return vscode.workspace.getConfiguration('labwindowsCvi').get<string[]>('additionalIncludePaths', [])
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => path.normalize(entry));
  }

  private findConfigurationRoot(workspacePath: string, preferOpenedFolder = true): string {
    const owner = preferOpenedFolder ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(workspacePath)) : undefined;
    return owner?.uri.fsPath ?? path.dirname(workspacePath);
  }

  private readExistingDocument(configPath: string): CppPropertiesDocument | undefined {
    if (!fs.existsSync(configPath)) {
      return {};
    }

    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(stripTrailingCommas(stripJsonComments(raw))) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('the root value is not a JSON object');
      }
      return parsed as CppPropertiesDocument;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[CVI] Cannot update ${configPath}: ${message}`);
      vscode.window.showWarningMessage(`The existing .vscode/c_cpp_properties.json file is invalid and was not modified: ${message}`);
      return undefined;
    }
  }

  private createManagedConfiguration(installation: CviInstallation, workspace: CviWorkspace): CppToolsConfiguration {
    const includeDirectory = path.join(installation.root, 'include');
    const ansiIncludeDirectory = path.join(includeDirectory, 'ansi');
    const clangIncludeDirectory = path.join(includeDirectory, 'clang');
    const toolsLibraryDirectory = path.join(installation.root, 'toolslib');
    const toolboxDirectory = path.join(toolsLibraryDirectory, 'toolbox');
    const windowsKitIncludeDirectories = findWindowsKitIncludeDirectories();
    const projectDirectories = this.collectProjectDirectories(workspace);
    const additional = this.getAdditionalIncludePaths();

    const includePath = unique([
      '${workspaceFolder}/**',
      ...projectDirectories,
      existingPath(includeDirectory),
      existingPath(ansiIncludeDirectory),
      existingPath(clangIncludeDirectory) ? `${clangIncludeDirectory}${path.sep}**` : undefined,
      existingPath(toolsLibraryDirectory),
      existingPath(toolsLibraryDirectory) ? `${toolsLibraryDirectory}${path.sep}**` : undefined,
      existingPath(toolboxDirectory),
      ...windowsKitIncludeDirectories,
      ...windowsKitIncludeDirectories.map((directory) => `${directory}${path.sep}**`),
      ...additional.map(existingPath)
    ].filter((value): value is string => !!value).map(toForwardSlashes));

    const browsePath = unique([
      '${workspaceFolder}',
      ...projectDirectories,
      existingPath(includeDirectory),
      existingPath(ansiIncludeDirectory),
      existingPath(clangIncludeDirectory),
      existingPath(toolsLibraryDirectory),
      existingPath(toolboxDirectory),
      ...windowsKitIncludeDirectories,
      ...additional.map(existingPath)
    ].filter((value): value is string => !!value).map(toForwardSlashes));

    const useProvider = vscode.workspace.getConfiguration('labwindowsCvi').get<boolean>('useCppToolsConfigurationProvider', true);
    const configuration: CppToolsConfiguration = {
      name: MANAGED_CONFIGURATION_NAME,
      intelliSenseMode: 'windows-clang-x86',
      cStandard: 'c11',
      cppStandard: 'c++17',
      includePath,
      browse: {
        path: browsePath,
        limitSymbolsToIncludedHeaders: false
      },
      defines: defaultDefines(),
      ...(useProvider ? { configurationProvider: CVI_CONFIGURATION_PROVIDER_ID, mergeConfigurations: true } : {})
    };

    const compilerPath = this.resolveCompilerPath(installation);
    if (compilerPath) {
      configuration.compilerPath = compilerPath;
    }
    return configuration;
  }
}

function defaultDefines(): string[] {
  return [
    '_WINDOWS',
    '_WIN32',
    'WIN32',
    '_CRT_SECURE_NO_WARNINGS'
  ];
}

function findWindowsKitIncludeDirectories(): string[] {
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const roots = unique([
    path.join(programFilesX86, 'Windows Kits', '10', 'Include'),
    path.join(programFiles, 'Windows Kits', '10', 'Include'),
    path.join(programFilesX86, 'Windows Kits', '8.1', 'Include'),
    path.join(programFiles, 'Windows Kits', '8.1', 'Include'),
    path.join(programFilesX86, 'Microsoft SDKs', 'Windows', 'v7.1A', 'Include'),
    path.join(programFiles, 'Microsoft SDKs', 'Windows', 'v7.1A', 'Include')
  ]);
  const result: string[] = [];
  for (const includeRoot of roots) {
    if (!fs.existsSync(includeRoot)) {
      continue;
    }
    result.push(includeRoot);
    result.push(...collectHeaderDirectories(includeRoot, 4, 1200));
    for (const entry of safeReadDirectories(includeRoot)) {
      const versionDirectory = path.join(includeRoot, entry.name);
      result.push(versionDirectory);
      for (const segment of ['ucrt', 'shared', 'um', 'winrt', 'cppwinrt']) {
        const candidate = path.join(versionDirectory, segment);
        if (fs.existsSync(candidate)) {
          result.push(candidate);
        }
      }
    }
    for (const segment of ['ucrt', 'shared', 'um', 'winrt', 'cppwinrt']) {
      const candidate = path.join(includeRoot, segment);
      if (fs.existsSync(candidate)) {
        result.push(candidate);
      }
    }
  }
  return unique(result.map(toForwardSlashes));
}

function findWindowsHeaderCandidates(): string[] {
  const result: string[] = [];
  for (const directory of findWindowsKitIncludeDirectories()) {
    const candidate = path.join(directory, 'windows.h');
    if (fs.existsSync(candidate)) {
      result.push(toForwardSlashes(candidate));
    }
  }
  return unique(result);
}

function findHeaderCandidates(root: string, names: string[], maxDepth: number, maxDirectories: number): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  const expected = new Set(names.map((name) => name.toLowerCase()));
  const result: string[] = [];
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  let visited = 0;
  while (queue.length && visited < maxDirectories) {
    const current = queue.shift()!;
    visited += 1;
    for (const entry of safeReadEntries(current.directory)) {
      if (entry.isFile() && expected.has(entry.name.toLowerCase())) {
        result.push(toForwardSlashes(path.join(current.directory, entry.name)));
      } else if (entry.isDirectory() && current.depth < maxDepth) {
        queue.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
      }
    }
  }
  return unique(result);
}

function collectHeaderDirectories(root: string, maxDepth: number, maxDirectories: number): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  const result: string[] = [];
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  while (queue.length && result.length < maxDirectories) {
    const current = queue.shift()!;
    const entries = safeReadEntries(current.directory);
    if (entries.some((entry) => entry.isFile() && /\.(h|hpp|hh|hxx)$/i.test(entry.name))) {
      result.push(current.directory);
    }
    if (current.depth >= maxDepth) {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        queue.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
      }
    }
  }
  if (!result.length) {
    result.push(root);
  }
  return unique(result.map(toForwardSlashes));
}

function safeReadEntries(directory: string): fs.Dirent[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeReadDirectories(directory: string): fs.Dirent[] {
  return safeReadEntries(directory).filter((entry) => entry.isDirectory());
}

function existingPath(value: string): string | undefined {
  return fs.existsSync(value) ? value : undefined;
}

function toForwardSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function isPathInside(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isCppFile(filePath: string): boolean {
  return ['.cpp', '.hpp', '.cc', '.cxx', '.hh', '.hxx'].includes(path.extname(filePath).toLowerCase());
}

function stripTrailingCommas(value: string): string {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];
    if (inString) {
      result += current;
      if (escaped) {
        escaped = false;
      } else if (current === '\\') {
        escaped = true;
      } else if (current === '"') {
        inString = false;
      }
      continue;
    }

    if (current === '"') {
      inString = true;
      result += current;
      continue;
    }

    if (current === ',') {
      let lookAhead = index + 1;
      while (lookAhead < value.length && /\s/.test(value[lookAhead])) {
        lookAhead += 1;
      }
      if (value[lookAhead] === '}' || value[lookAhead] === ']') {
        continue;
      }
    }
    result += current;
  }

  return result;
}

function stripJsonComments(value: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];
    const next = value[index + 1];

    if (lineComment) {
      if (current === '\n' || current === '\r') {
        lineComment = false;
        result += current;
      }
      continue;
    }

    if (blockComment) {
      if (current === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }

    if (inString) {
      result += current;
      if (escaped) {
        escaped = false;
      } else if (current === '\\') {
        escaped = true;
      } else if (current === '"') {
        inString = false;
      }
      continue;
    }

    if (current === '"') {
      inString = true;
      result += current;
      continue;
    }

    if (current === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }

    if (current === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }

    result += current;
  }

  return result;
}
