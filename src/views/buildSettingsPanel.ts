import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CviNativeCompilerSettings, CviNativeTargetSettings, CviParser, CviProjectCompilerSettings, CviWorkspaceNativeBuildOptions } from '../model/cviParser';
import { CviBuildMode, CviWorkspaceProjectRef } from '../model/types';
import { CviProjectBuildSettings, CviProjectSettingsService } from '../services/cviProjectSettingsService';
import { CviDllAnalysis, analyzeDllFile, renderDllAnalysisMarkdown } from '../services/cviDllAnalyzerService';
import { CviLibraryAnalysis, analyzeLibraryFile, renderLibraryAnalysisMarkdown } from '../services/cviLibraryAnalyzerService';
import { CviAutocompleteProfile, getCviAutocompleteSettings } from '../services/cviSymbolService';
import { CviWorkspaceService } from '../services/cviWorkspaceService';
import { normalizeRuntimePath } from '../utils/pathUtils';

type BuildSettingsScope = CviBuildMode | 'all' | `custom:${string}`;

const ALL_BUILD_MODES: CviBuildMode[] = ['debug', 'release', 'debug64', 'release64'];

const RUNTIME_SUPPORT_OPTIONS: SelectOption[] = [
  ['Full Runtime Support', 'Full run-time engine'],
  ['Instrument Driver Support Only', 'Instrument driver only']
];

const EXE_RUNTIME_BINDING_OPTIONS: SelectOption[] = [
  ['Shared', 'Shared'],
  ['Side-by-side For Application', 'Side-by-side for entire application'],
  ['Side-by-side', 'Side-by-side for executable only']
];

const DLL_RUNTIME_BINDING_OPTIONS: SelectOption[] = [
  ['Shared', 'Shared'],
  ['Side-by-side', 'Side-by-side']
];

const SOURCE_DOCUMENTATION_OPTIONS: SelectOption[] = [
  ['None', 'None'],
  ['XML', 'XML'],
  ['HTML', 'HTML'],
  ['XML & HTML', 'XML & HTML']
];

const DLL_COPY_OPTIONS: SelectOption[] = [
  ['Do not copy', 'Do not copy'],
  ['Windows system directory', 'Windows system directory'],
  ['IVI standard root directory', 'IVI standard root directory'],
  ['VXIplug&play directory', 'VXIplug&play directory'],
  ['IVI standard root directory + VXIplug&play directory', 'IVI standard root directory + VXIplug&play directory'],
  ['Custom directory', 'Custom directory']
];

const DLL_EXPORT_OPTIONS: SelectOption[] = [
  ['Include File Symbols', 'Include file symbols'],
  ['Symbols Marked As Export', 'Symbols marked for export'],
  ['Include File and Marked Symbols', 'Include file and marked symbols']
];

const TLB_HELP_STYLE_OPTIONS: SelectOption[] = [
  ['HLP', 'HLP'],
  ['CHM', 'CHM']
];

export class BuildSettingsPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private projectRef?: CviWorkspaceProjectRef;
  private selectedScope: BuildSettingsScope = 'debug';
  private selectedPage = '';
  private dllAnalyzerPath = '';
  private dllAnalysis?: CviDllAnalysis;
  private libraryAnalyzerPath = '';
  private libraryAnalysis?: CviLibraryAnalysis;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly workspaces: CviWorkspaceService,
    private readonly parser: CviParser,
    private readonly settings: CviProjectSettingsService
  ) {
    this.disposables.push(this.workspaces.onDidChange(() => this.handleWorkspaceChanged()));
  }

  show(projectRef?: CviWorkspaceProjectRef, page?: string): void {
    const ref = projectRef ?? this.workspaces.activeProjectRef;
    if (!ref?.exists) {
      vscode.window.showErrorMessage('No existing CVI project is selected.');
      return;
    }
    this.projectRef = ref;
    if (page) this.selectedPage = page;
    if (!this.panel) {
      this.selectedScope = this.scopeForProject(ref);
      this.panel = vscode.window.createWebviewPanel('labwindowsCvi.buildSettings', 'CVI Project Build Settings', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
      this.panel.onDidDispose(() => { this.panel = undefined; this.projectRef = undefined; this.selectedPage = ''; });
      this.panel.webview.onDidReceiveMessage((message) => void this.handleMessage(message));
    }
    this.panel.title = `CVI Build Settings — ${ref.name}`;
    this.panel.webview.html = this.render(ref);
    this.panel.reveal(vscode.ViewColumn.Active);
  }

  showDllAnalyzer(projectRef?: CviWorkspaceProjectRef, dllPath?: string): void {
    const ref = projectRef ?? this.workspaces.activeProjectRef;
    if (dllPath) {
      this.dllAnalyzerPath = dllPath;
      try { this.dllAnalysis = analyzeDllFile(dllPath); }
      catch (error) { this.dllAnalysis = undefined; vscode.window.showErrorMessage(`Unable to analyze DLL: ${error instanceof Error ? error.message : String(error)}`); }
    }
    this.show(ref, 'dllAnalyzer');
  }

  showLibraryAnalyzer(projectRef?: CviWorkspaceProjectRef, libraryPath?: string): void {
    const ref = projectRef ?? this.workspaces.activeProjectRef;
    if (libraryPath) {
      this.libraryAnalyzerPath = libraryPath;
      try { this.libraryAnalysis = analyzeLibraryFile(libraryPath); }
      catch (error) { this.libraryAnalysis = undefined; vscode.window.showErrorMessage(`Unable to analyze library: ${error instanceof Error ? error.message : String(error)}`); }
    }
    this.show(ref, 'libraryAnalyzer');
  }

  update(): void {
    if (this.panel && this.projectRef?.exists) {
      this.panel.webview.html = this.render(this.projectRef);
    }
  }

  /**
   * Native VS Code fallback for machines where Chromium's webview service
   * worker is temporarily unavailable. It intentionally covers the settings
   * most often changed during a build workflow and uses the exact same parser
   * and backup path as the full HTML editor.
   */
  async showSafeMode(projectRef?: CviWorkspaceProjectRef): Promise<void> {
    const ref = projectRef ?? this.workspaces.activeProjectRef;
    if (!ref?.exists) {
      vscode.window.showErrorMessage('No existing CVI project is selected.');
      return;
    }
    let scope = this.scopeIsAvailable(ref, this.selectedScope) ? this.selectedScope : this.scopeForProject(ref);

    while (true) {
      const representativeMode = this.representativeMode(scope);
      const customName = customScopeName(scope);
      const customWorkspaceSerialized = customName ? this.settings.hasWorkspaceConfigurationSection(ref, customName) : true;
      const target = this.targetForScope(ref, scope);
      const projectSettings = this.settingsForScope(ref, scope);
      const choice = await vscode.window.showQuickPick([
        { id: 'full', label: '$(globe) Open full build-settings page', description: 'Use the HTML editor when VS Code webviews are available.' },
        { id: 'scope', label: '$(settings) Configuration scope', description: scopeLabel(scope) },
        { id: 'targetType', label: '$(symbol-enum) Target type', description: target.targetType },
        { id: 'outputPath', label: '$(file) Output file', description: target.outputPath || 'Empty' },
        { id: 'applicationTitle', label: '$(tag) Application title', description: target.applicationTitle || 'Empty' },
        { id: 'iconFile', label: '$(file-media) Application icon file', description: target.iconFile || 'Empty' },
        { id: 'runtimeSupport', label: '$(gear) Run-time support', description: target.runtimeSupport || 'Empty' },
        { id: 'runtimeBinding', label: '$(link) Run-time engine binding', description: target.runtimeBinding || 'Empty' },
        { id: 'generateSourceDocumentation', label: '$(book) Generate help from source', description: target.generateSourceDocumentation || 'Empty' },
        { id: 'arguments', label: '$(terminal) Command-line arguments', description: projectSettings.run.arguments || 'Empty' },
        { id: 'workingDirectory', label: '$(folder) Working directory', description: projectSettings.run.workingDirectory || 'Empty' },
        { id: 'environmentOptions', label: '$(symbol-key) Environment options', description: projectSettings.run.environmentOptions || 'Empty' },
        { id: 'externalProcessPath', label: '$(run) Program name', description: target.targetType === 'Dynamic Link Library' ? (projectSettings.run.externalProcessPath || 'Empty — required to run this DLL target') : target.targetType === 'Executable' ? (target.outputPath || 'Uses the built executable') : 'Not applicable to static libraries' },
        { id: 'preBuildActions', label: '$(list-ordered) Pre-build actions', description: customName ? 'Owned by the named CVI configuration / compile.exe' : `${projectSettings.preBuildActions.length} action(s)` },
        { id: 'customBuildActions', label: '$(list-ordered) Custom build actions', description: customName ? 'Owned by the named CVI configuration / compile.exe' : `${projectSettings.customBuildActions.length} action(s)` },
        { id: 'postBuildActions', label: '$(list-ordered) Post-build actions', description: customName ? 'Owned by the named CVI configuration / compile.exe' : `${projectSettings.postBuildActions.length} action(s)` },
        { id: 'forcedModules', label: '$(library) LoadExternalModule files', description: `${target.forcedModules.length} module(s)` },
        { id: 'close', label: '$(close) Close safe-mode editor' }
      ], { title: `CVI Build Settings (Safe Mode) — ${ref.name}`, placeHolder: 'Select a setting to edit' });

      if (!choice || choice.id === 'close') {
        this.selectedScope = scope;
        return;
      }
      if (choice.id === 'full') {
        this.selectedScope = scope;
        this.show(ref);
        return;
      }
      if (choice.id === 'scope') {
        const selected = await vscode.window.showQuickPick(scopeChoices(this.customConfigurationNames(ref)), { title: 'Select configuration scope' });
        if (selected) {
          scope = selected.id;
          this.selectedScope = scope;
        }
        continue;
      }
      if (customName && ['preBuildActions', 'customBuildActions', 'postBuildActions'].includes(choice.id)) {
        vscode.window.showInformationMessage(`Build Steps for named CVI configuration ${customName} remain owned by CVI/compile.exe and are not rewritten by CVI PM.`);
        continue;
      }
      if (customName && !customWorkspaceSerialized && ['arguments', 'workingDirectory', 'environmentOptions', 'externalProcessPath'].includes(choice.id)) {
        vscode.window.showWarningMessage(`Run/Debug settings for ${customName} are read-only because the current .cws does not contain a serialized custom configuration section. Open/save that configuration in CVI first.`);
        continue;
      }
      if (choice.id === 'targetType') {
        const selected = await vscode.window.showQuickPick(['Executable', 'Dynamic Link Library', 'Static Library'], { title: 'Select CVI target type' });
        if (selected) {
          target.targetType = selected;
          this.applyNativeTargetSettings(ref, scope, target);
          this.workspaces.refresh();
        }
        continue;
      }

      if (choice.id === 'runtimeSupport') {
        const value = await pickStoredValue('Select run-time support', RUNTIME_SUPPORT_OPTIONS, target.runtimeSupport);
        if (value !== undefined) {
          target.runtimeSupport = value;
          this.applyNativeTargetSettings(ref, scope, target);
          this.workspaces.refresh();
        }
        continue;
      }
      if (choice.id === 'runtimeBinding') {
        const options = target.targetType === 'Dynamic Link Library' ? DLL_RUNTIME_BINDING_OPTIONS : EXE_RUNTIME_BINDING_OPTIONS;
        const value = await pickStoredValue('Select run-time engine binding', options, target.runtimeBinding);
        if (value !== undefined) {
          target.runtimeBinding = value;
          this.applyNativeTargetSettings(ref, scope, target);
          this.workspaces.refresh();
        }
        continue;
      }
      if (choice.id === 'generateSourceDocumentation') {
        const value = await pickStoredValue('Select generated help format', SOURCE_DOCUMENTATION_OPTIONS, target.generateSourceDocumentation);
        if (value !== undefined) {
          target.generateSourceDocumentation = value;
          this.applyNativeTargetSettings(ref, scope, target);
          this.workspaces.refresh();
        }
        continue;
      }

      const nativeTextFields: Record<string, keyof Pick<CviNativeTargetSettings, 'outputPath' | 'applicationTitle' | 'iconFile'>> = {
        outputPath: 'outputPath',
        applicationTitle: 'applicationTitle',
        iconFile: 'iconFile'
      };
      const runTextFields: Record<string, keyof CviProjectBuildSettings['run']> = {
        arguments: 'arguments',
        workingDirectory: 'workingDirectory',
        environmentOptions: 'environmentOptions',
        externalProcessPath: 'externalProcessPath'
      };

      if (choice.id in nativeTextFields) {
        const key = nativeTextFields[choice.id];
        const value = await vscode.window.showInputBox({ title: stripCodicon(choice.label), value: String(target[key] ?? ''), ignoreFocusOut: true });
        if (value !== undefined) {
          target[key] = value;
          this.applyNativeTargetSettings(ref, scope, target);
          this.workspaces.refresh();
        }
        continue;
      }
      if (choice.id in runTextFields) {
        const key = runTextFields[choice.id];
        if (key === 'externalProcessPath' && target.targetType !== 'Dynamic Link Library') {
          vscode.window.showInformationMessage(target.targetType === 'Executable'
            ? 'For an executable target, Program Name is the built output file and is not editable, matching LabWindows/CVI.'
            : 'Static library targets do not have a runnable Program Name.');
          continue;
        }
        const value = await vscode.window.showInputBox({ title: stripCodicon(choice.label), value: projectSettings.run[key], ignoreFocusOut: true });
        if (value !== undefined) {
          projectSettings.run[key] = value;
          this.applyProjectSettings(ref, scope, projectSettings);
          this.workspaces.refresh();
        }
        continue;
      }

      const actionFields: Record<string, keyof Pick<CviProjectBuildSettings, 'preBuildActions' | 'customBuildActions' | 'postBuildActions'>> = {
        preBuildActions: 'preBuildActions',
        customBuildActions: 'customBuildActions',
        postBuildActions: 'postBuildActions'
      };
      if (choice.id in actionFields) {
        const key = actionFields[choice.id];
        const value = await vscode.window.showInputBox({
          title: stripCodicon(choice.label),
          prompt: 'Enter one action per line or separate actions with semicolons.',
          value: projectSettings[key].join('; '),
          ignoreFocusOut: true
        });
        if (value !== undefined) {
          projectSettings[key] = splitSafeList(value);
          this.applyProjectSettings(ref, scope, projectSettings);
          this.workspaces.refresh();
        }
        continue;
      }
      if (choice.id === 'forcedModules') {
        if (target.runtimeSupport === 'Instrument Driver Support Only') {
          vscode.window.showWarningMessage('LoadExternalModule options are unavailable when run-time support is Instrument Driver Support Only.');
          continue;
        }
        const value = await vscode.window.showInputBox({
          title: 'LoadExternalModule files',
          prompt: 'Enter one .lib or .obj file per line or separate entries with semicolons.',
          value: target.forcedModules.join('; '),
          ignoreFocusOut: true
        });
        if (value !== undefined) {
          target.forcedModules = splitSafeList(value);
          target.usingLoadExternalModule = target.forcedModules.length > 0;
          this.applyNativeTargetSettings(ref, scope, target);
          this.workspaces.refresh();
        }
      }
    }
  }

  dispose(): void {
    this.panel?.dispose();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }

  private handleWorkspaceChanged(): void {
    if (!this.panel || !this.projectRef) return;
    const current = this.workspaces.currentWorkspace?.projects.find((candidate) => path.normalize(candidate.absolutePath).toLowerCase() === path.normalize(this.projectRef!.absolutePath).toLowerCase());
    if (!current?.exists) {
      this.panel.dispose();
      return;
    }
    this.projectRef = current;
    this.update();
  }

  private async handleMessage(message: any): Promise<void> {
    if (!this.projectRef) {
      return;
    }
    if (message?.type === 'pageChanged') {
      const page = String(message.page ?? '');
      if (page) this.selectedPage = page;
      return;
    }
    if (message?.type === 'changeScope') {
      this.selectedScope = parseScope(message.scope, this.buildMode);
      this.update();
      return;
    }
    if (message?.type === 'browseDllAnalyzer') {
      const chosen = await vscode.window.showOpenDialog({
        title: 'Select DLL to analyze', canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
        defaultUri: vscode.Uri.file(this.dllAnalyzerPath && fs.existsSync(this.dllAnalyzerPath) ? this.dllAnalyzerPath : path.dirname(this.projectRef.absolutePath)),
        filters: { 'Windows DLL': ['dll'], 'All files': ['*'] }
      });
      if (chosen?.[0]) {
        this.dllAnalyzerPath = chosen[0].fsPath;
        try { this.dllAnalysis = analyzeDllFile(this.dllAnalyzerPath); }
        catch (error) { this.dllAnalysis = undefined; vscode.window.showErrorMessage(`Unable to analyze DLL: ${error instanceof Error ? error.message : String(error)}`); }
        this.selectedPage = 'dllAnalyzer';
        this.update();
      }
      return;
    }
    if (message?.type === 'analyzeDll') {
      const requested = String(message.path ?? this.dllAnalyzerPath ?? '').trim();
      if (!requested) { await this.handleMessage({ type: 'browseDllAnalyzer' }); return; }
      this.dllAnalyzerPath = requested;
      try { this.dllAnalysis = analyzeDllFile(requested); }
      catch (error) { this.dllAnalysis = undefined; vscode.window.showErrorMessage(`Unable to analyze DLL: ${error instanceof Error ? error.message : String(error)}`); }
      this.selectedPage = 'dllAnalyzer';
      this.update();
      return;
    }
    if (message?.type === 'exportDllAnalysis') {
      if (!this.dllAnalysis) { vscode.window.showInformationMessage('Analyze a DLL first.'); return; }
      const base = path.parse(this.dllAnalysis.fileName).name;
      const target = await vscode.window.showSaveDialog({
        title: 'Export DLL analysis report',
        defaultUri: vscode.Uri.file(path.join(path.dirname(this.projectRef.absolutePath), '.vscode', 'cvi-dll-analyzer', `${base}-analysis.md`)),
        filters: { Markdown: ['md'], 'Text files': ['txt'] }
      });
      if (target) {
        fs.mkdirSync(path.dirname(target.fsPath), { recursive: true });
        fs.writeFileSync(target.fsPath, renderDllAnalysisMarkdown(this.dllAnalysis), 'utf8');
        vscode.window.showInformationMessage(`DLL analysis exported to ${target.fsPath}`);
      }
      return;
    }
    if (message?.type === 'browseLibraryAnalyzer') {
      const chosen = await vscode.window.showOpenDialog({
        title: 'Select .a or .lib library to analyze', canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
        defaultUri: vscode.Uri.file(this.libraryAnalyzerPath && fs.existsSync(this.libraryAnalyzerPath) ? this.libraryAnalyzerPath : path.dirname(this.projectRef.absolutePath)),
        filters: { 'Static/import libraries': ['a', 'lib'], 'All files': ['*'] }
      });
      if (chosen?.[0]) {
        this.libraryAnalyzerPath = chosen[0].fsPath;
        try { this.libraryAnalysis = analyzeLibraryFile(this.libraryAnalyzerPath); }
        catch (error) { this.libraryAnalysis = undefined; vscode.window.showErrorMessage(`Unable to analyze library: ${error instanceof Error ? error.message : String(error)}`); }
        this.selectedPage = 'libraryAnalyzer';
        this.update();
      }
      return;
    }
    if (message?.type === 'analyzeLibrary') {
      const requested = String(message.path ?? this.libraryAnalyzerPath ?? '').trim();
      if (!requested) { await this.handleMessage({ type: 'browseLibraryAnalyzer' }); return; }
      this.libraryAnalyzerPath = requested;
      try { this.libraryAnalysis = analyzeLibraryFile(requested); }
      catch (error) { this.libraryAnalysis = undefined; vscode.window.showErrorMessage(`Unable to analyze library: ${error instanceof Error ? error.message : String(error)}`); }
      this.selectedPage = 'libraryAnalyzer';
      this.update();
      return;
    }
    if (message?.type === 'exportLibraryAnalysis') {
      if (!this.libraryAnalysis) { vscode.window.showInformationMessage('Analyze a .a/.lib library first.'); return; }
      const base = path.parse(this.libraryAnalysis.fileName).name;
      const target = await vscode.window.showSaveDialog({
        title: 'Export library analysis report',
        defaultUri: vscode.Uri.file(path.join(path.dirname(this.projectRef.absolutePath), '.vscode', 'cvi-library-analyzer', `${base}-analysis.md`)),
        filters: { Markdown: ['md'], 'Text files': ['txt'] }
      });
      if (target) {
        fs.mkdirSync(path.dirname(target.fsPath), { recursive: true });
        fs.writeFileSync(target.fsPath, renderLibraryAnalysisMarkdown(this.libraryAnalysis), 'utf8');
        vscode.window.showInformationMessage(`Library analysis exported to ${target.fsPath}`);
      }
      return;
    }
    if (message?.type === 'browse') {
      await this.browseForField(String(message.field ?? ''));
      return;
    }
    if (message?.type === 'browseForcedModules') {
      await this.browseForForcedModules();
      return;
    }
    if (message?.type === 'promptForcedModuleName') {
      await this.promptForForcedModuleName();
      return;
    }
    if (message?.type === 'command') {
      const command = String(message.command ?? '');
      if (command) {
        await vscode.commands.executeCommand(command);
      }
      return;
    }
    if (message?.type === 'save') {
      try {
        const current = this.workspaces.currentWorkspace?.projects.find((candidate) => path.normalize(candidate.absolutePath).toLowerCase() === path.normalize(this.projectRef!.absolutePath).toLowerCase());
        if (!current?.exists) {
          throw new Error('The CVI project shown by this panel is no longer part of the active workspace. Reopen Build Settings from the current project tree.');
        }
        this.projectRef = current;
        const scope = parseScope(message.scope, this.selectedScope);
        this.selectedScope = scope;
        const settings = message.settings as CviProjectBuildSettings;
        const targetSettings = message.nativeTarget as CviNativeTargetSettings;
        if (typeof message.targetType === 'string') {
          targetSettings.targetType = message.targetType;
        }
        const compilerSettings = message.nativeCompiler as CviNativeCompilerSettings;
        const projectCompilerSettings = message.projectCompiler as CviProjectCompilerSettings;
        const workspaceBuildSettings = message.workspaceBuild as CviWorkspaceNativeBuildOptions | undefined;
        this.applyNativeTargetSettings(this.projectRef, scope, targetSettings);
        this.applyNativeCompilerSettings(this.projectRef, scope, compilerSettings);
        this.parser.setProjectCompilerSettings(this.projectRef.absolutePath, projectCompilerSettings);
        if (workspaceBuildSettings) {
          this.applyWorkspaceBuildSettings(this.projectRef, scope, workspaceBuildSettings);
        }
        this.applyProjectSettings(this.projectRef, scope, settings);
        if (typeof message.buildLogDetail === 'string') {
          const detail = normalizeBuildLogDetail(message.buildLogDetail);
          await vscode.workspace.getConfiguration('labwindowsCvi').update('buildLogDetail', detail, vscode.ConfigurationTarget.Workspace);
        }
        if (message.autocomplete) {
          await this.saveAutocompleteSettings(message.autocomplete);
        }
        this.workspaces.refresh();
        vscode.window.showInformationMessage(`Project settings saved for ${this.projectRef.name} (${scopeLabel(scope)}).`);
        this.update();
      } catch (error) {
        vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    }
  }

  private async saveAutocompleteSettings(value: any): Promise<CviAutocompleteProfile> {
    const profile = normalizeAutocompleteProfile(value?.profile);
    const config = vscode.workspace.getConfiguration('labwindowsCvi');
    const target = vscode.ConfigurationTarget.Workspace;
    await config.update('autocompleteProfile', profile, target);
    await config.update('enableSupplementalCompletionProvider', Boolean(value?.completionEnabled), target);
    await config.update('enableSupplementalProjectCompletion', Boolean(value?.includeProjectCompletion), target);
    await config.update('enableSupplementalCviApiCompletion', Boolean(value?.includeCviApiCompletion), target);
    await config.update('enableSupplementalSignatureHelp', Boolean(value?.signatureHelpEnabled), target);
    return profile;
  }

  private applyNativeTargetSettings(ref: CviWorkspaceProjectRef, scope: BuildSettingsScope, target: CviNativeTargetSettings): void {
    const customName = customScopeName(scope);
    if (customName) {
      this.parser.setNativeTargetSettingsForConfiguration(ref.absolutePath, customName, target);
      return;
    }
    this.parser.setTargetType(ref.absolutePath, target.targetType);
    for (const mode of scopeModes(scope)) this.parser.setNativeTargetSettings(ref.absolutePath, mode, target);
  }

  private applyNativeCompilerSettings(ref: CviWorkspaceProjectRef, scope: BuildSettingsScope, settings: CviNativeCompilerSettings): void {
    const customName = customScopeName(scope);
    if (customName) {
      this.parser.setNativeCompilerSettingsForConfiguration(ref.absolutePath, customName, settings);
      return;
    }
    for (const mode of scopeModes(scope)) this.parser.setNativeCompilerSettings(ref.absolutePath, mode, settings);
  }

  private applyWorkspaceBuildSettings(ref: CviWorkspaceProjectRef, scope: BuildSettingsScope, settings: CviWorkspaceNativeBuildOptions): void {
    const workspace = this.workspaces.currentWorkspace;
    if (!workspace?.path.toLowerCase().endsWith('.cws')) return;
    const customName = customScopeName(scope);
    if (customName) {
      this.parser.setWorkspaceNativeBuildOptionsForConfiguration(workspace.path, ref.index, customName, settings);
      return;
    }
    for (const mode of scopeModes(scope)) this.parser.setWorkspaceNativeBuildOptions(workspace.path, ref.index, mode, settings);
  }

  private applyProjectSettings(ref: CviWorkspaceProjectRef, scope: BuildSettingsScope, settings: CviProjectBuildSettings): void {
    const customName = customScopeName(scope);
    if (customName) {
      this.settings.setCustomConfigurationMetadata(ref, customName, settings, this.settings.hasWorkspaceConfigurationSection(ref, customName));
      return;
    }
    for (const mode of scopeModes(scope)) this.settings.setSettings(ref, settings, mode);
  }

  private async browseForField(field: string): Promise<void> {
    const ref = this.projectRef;
    if (!ref) {
      return;
    }
    const target = this.targetForScope(ref, this.selectedScope);
    const projectSettings = this.settingsForScope(ref, this.selectedScope);
    const projectDirectory = path.dirname(ref.absolutePath);
    const currentValues: Record<string, string> = {
      outputPath: target.outputPath,
      iconFile: target.iconFile,
      manifestPath: target.manifestPath,
      customDirectoryToCopyDll: target.customDirectoryToCopyDll,
      typeLibFpFile: target.typeLibFpFile,
      singleHeaderNiTypeInfoFile: target.singleHeaderNiTypeInfoFile,
      workingDirectory: projectSettings.run.workingDirectory,
      externalProcessPath: projectSettings.run.externalProcessPath
    };
    if (!(field in currentValues)) {
      return;
    }
    const currentValue = currentValues[field];
    const defaultUri = defaultDialogUri(currentValue, projectDirectory);
    let selected: vscode.Uri | undefined;

    if (field === 'workingDirectory' || field === 'customDirectoryToCopyDll') {
      selected = (await vscode.window.showOpenDialog({
        title: browseTitle(field),
        defaultUri,
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Select folder'
      }))?.[0];
    } else if (field === 'outputPath') {
      selected = await vscode.window.showSaveDialog({
        title: browseTitle(field),
        defaultUri,
        saveLabel: 'Select output file',
        filters: outputFilters(target.targetType)
      });
    } else {
      selected = (await vscode.window.showOpenDialog({
        title: browseTitle(field),
        defaultUri,
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: 'Select file',
        filters: openFilters(field)
      }))?.[0];
    }

    if (selected) {
      await this.panel?.webview.postMessage({ type: 'setField', field, value: selected.fsPath });
    }
  }

  private async browseForForcedModules(): Promise<void> {
    const ref = this.projectRef;
    if (!ref) {
      return;
    }
    const projectDirectory = path.dirname(ref.absolutePath);
    const selected = await vscode.window.showOpenDialog({
      title: 'Add files to executable or DLL',
      defaultUri: vscode.Uri.file(projectDirectory),
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: 'Add selected modules',
      filters: { 'Libraries and object files': ['lib', 'obj'], 'All files': ['*'] }
    });
    if (!selected?.length) {
      return;
    }
    const values = selected.map((uri) => portableModulePath(uri.fsPath, projectDirectory));
    await this.panel?.webview.postMessage({ type: 'appendForcedModules', values });
  }

  private async promptForForcedModuleName(): Promise<void> {
    const value = await vscode.window.showInputBox({
      title: 'Add LoadExternalModule entry',
      prompt: 'Enter a CVI library or object module name, for example toolbox.obj or advanlys.lib.',
      placeHolder: 'module.lib or module.obj',
      ignoreFocusOut: true,
      validateInput: (input) => input.trim() ? undefined : 'Enter a module name.'
    });
    if (!value?.trim()) {
      return;
    }
    await this.panel?.webview.postMessage({ type: 'appendForcedModules', values: [value.trim()] });
  }

  private get buildMode(): CviBuildMode {
    const ref = this.projectRef ?? this.workspaces.activeProjectRef;
    return (ref ? this.workspaces.getProjectBuildMode(ref) : undefined)
      ?? vscode.workspace.getConfiguration('labwindowsCvi').get<CviBuildMode>('buildMode', 'debug');
  }

  private customConfigurationNames(ref: CviWorkspaceProjectRef): string[] {
    return this.parser.getNativeBuildConfigurations(ref.absolutePath).filter((entry) => entry.isCustom).map((entry) => entry.name);
  }

  private scopeForProject(ref: CviWorkspaceProjectRef): BuildSettingsScope {
    const nativeName = this.workspaces.getProjectBuildConfiguration(ref)?.trim() || ref.buildConfiguration?.trim() || '';
    if (nativeName && !this.workspaces.getProjectBuildMode(ref) && this.parser.getNativeBuildConfiguration(ref.absolutePath, nativeName)?.isCustom) {
      return customScope(nativeName);
    }
    return this.workspaces.getProjectBuildMode(ref) ?? this.buildMode;
  }

  private scopeIsAvailable(ref: CviWorkspaceProjectRef, scope: BuildSettingsScope): boolean {
    const customName = customScopeName(scope);
    return !customName || Boolean(this.parser.getNativeBuildConfiguration(ref.absolutePath, customName));
  }

  private representativeMode(scope: BuildSettingsScope): CviBuildMode {
    if (scope === 'all') return this.buildMode;
    const customName = customScopeName(scope);
    if (!customName) return scope as CviBuildMode;
    const ref = this.projectRef ?? this.workspaces.activeProjectRef;
    const descriptor = ref?.exists ? this.parser.getNativeBuildConfiguration(ref.absolutePath, customName) : undefined;
    if (descriptor) return descriptor.is64Bit ? (descriptor.isRelease ? 'release64' : 'debug64') : (descriptor.isRelease ? 'release' : 'debug');
    return this.buildMode;
  }

  private targetForScope(ref: CviWorkspaceProjectRef, scope: BuildSettingsScope): CviNativeTargetSettings {
    const mode = this.representativeMode(scope);
    const customName = customScopeName(scope);
    return customName ? (this.parser.getNativeTargetSettingsForConfiguration(ref.absolutePath, customName, mode) ?? this.parser.getNativeTargetSettings(ref.absolutePath, mode)) : this.parser.getNativeTargetSettings(ref.absolutePath, mode);
  }

  private compilerForScope(ref: CviWorkspaceProjectRef, scope: BuildSettingsScope): CviNativeCompilerSettings {
    const mode = this.representativeMode(scope);
    const customName = customScopeName(scope);
    return customName ? (this.parser.getNativeCompilerSettingsForConfiguration(ref.absolutePath, customName) ?? this.parser.getNativeCompilerSettings(ref.absolutePath, mode)) : this.parser.getNativeCompilerSettings(ref.absolutePath, mode);
  }

  private settingsForScope(ref: CviWorkspaceProjectRef, scope: BuildSettingsScope): CviProjectBuildSettings {
    const mode = this.representativeMode(scope);
    const customName = customScopeName(scope);
    return customName ? this.settings.getSettingsForConfiguration(ref, customName, mode) : this.settings.getSettings(ref, mode);
  }

  private workspaceBuildForScope(ref: CviWorkspaceProjectRef, scope: BuildSettingsScope): CviWorkspaceNativeBuildOptions | undefined {
    const workspace = this.workspaces.currentWorkspace;
    if (!workspace?.path.toLowerCase().endsWith('.cws')) return undefined;
    const customName = customScopeName(scope);
    return customName ? this.parser.getWorkspaceNativeBuildOptionsForConfiguration(workspace.path, ref.index, customName) : this.parser.getWorkspaceNativeBuildOptions(workspace.path, ref.index, this.representativeMode(scope));
  }

  private render(ref: CviWorkspaceProjectRef): string {
    const representativeMode = this.representativeMode(this.selectedScope);
    const customName = customScopeName(this.selectedScope);
    const project = this.workspaces.getProject(ref);
    const settings = this.settingsForScope(ref, this.selectedScope);
    const target = this.targetForScope(ref, this.selectedScope);
    const compiler = this.compilerForScope(ref, this.selectedScope);
    const projectCompiler = this.parser.getProjectCompilerSettings(ref.absolutePath);
    const externalSupport = this.parser.getExternalCompilerSupportSettings(ref.absolutePath);
    const compilerIssues = customName
      ? this.parser.inspectNativeCompilerConfigurationForConfiguration(ref.absolutePath, customName, representativeMode)
      : this.parser.inspectNativeCompilerConfiguration(ref.absolutePath, representativeMode);
    const workspace = this.workspaces.currentWorkspace;
    const workspaceBuild = this.workspaceBuildForScope(ref, this.selectedScope);
    const customWorkspaceSerialized = customName ? this.settings.hasWorkspaceConfigurationSection(ref, customName) : true;
    const mode = this.selectedScope;
    const dependencies = workspace?.projects.filter((candidate) => candidate.index !== ref.index).map((candidate) => {
      const key = this.settings.dependencyKey(candidate);
      return `<label class="dependency"><input type="checkbox" data-dependency="${escapeHtml(key)}" ${settings.dependencies.includes(key) ? 'checked' : ''}> <span>${escapeHtml(candidate.name)}</span><small>${escapeHtml(candidate.relativePath)}</small></label>`;
    }).join('') || '<div class="muted">No other project is available in the current CVI workspace.</div>';
    const includeFiles = project?.files.filter((file) => file.type === 'Include').map((file) => file.relativePath ?? file.absolutePath) ?? [];
    const exportFileChecks = includeFiles.length
      ? includeFiles.map((file) => `<label class="check"><input type="checkbox" data-export-file value="${escapeHtml(file)}" ${target.exportFiles.includes(file) || target.exportFiles.includes(file.split(/[\\/]/).pop() ?? file) ? 'checked' : ''}> ${escapeHtml(file)}</label>`).join('')
      : '<div class="muted">No header file is referenced by this project.</div>';
    const runtimeBindingOptions = target.targetType === 'Dynamic Link Library' ? DLL_RUNTIME_BINDING_OPTIONS : EXE_RUNTIME_BINDING_OPTIONS;
    const cviConfig = vscode.workspace.getConfiguration('labwindowsCvi');
    const buildLogDetail = normalizeBuildLogDetail(cviConfig.get<string>('buildLogDetail', 'normal'));
    const autocomplete = getCviAutocompleteSettings();
    const autocompleteProfile = autocomplete.profile;
    const autocompleteCustom = {
      completionEnabled: cviConfig.get<boolean>('enableSupplementalCompletionProvider', true),
      includeProjectCompletion: cviConfig.get<boolean>('enableSupplementalProjectCompletion', true),
      includeCviApiCompletion: cviConfig.get<boolean>('enableSupplementalCviApiCompletion', true),
      signatureHelpEnabled: cviConfig.get<boolean>('enableSupplementalSignatureHelp', true)
    };
    const logDetailOptions: SelectOption[] = [
      ['compact', 'Compact: phases, summary, warnings and errors'],
      ['normal', 'Normal: phases, durations and structured diagnostics'],
      ['verbose', 'Verbose: normal report plus commands and successful tool output']
    ];
    const settingsPages = [
      { id: 'overview', label: 'Overview', description: 'Project status and common CVI actions.' },
      { id: 'project', label: 'Project', description: 'Target type, output path and native .prj storage.' },
      { id: 'compiler', label: 'Compiler & Linker', description: 'Per-configuration compiler options, defines, include paths, warnings and memory settings.' },
      { id: 'external', label: 'External Compiler', description: 'Choose the native CVI compiler or an external Microsoft Visual C++ build and configure VS Code debugging.' },
      { id: 'libraries', label: 'Libraries', description: 'Generate Windows import libraries from headers or DLLs and configure DLL link-time outputs.' },
      { id: 'dllAnalyzer', label: 'DLL Analyzer', description: 'Inspect PE metadata, versions, exports, imports, resources and debug information.' },
      { id: 'libraryAnalyzer', label: '.a / .lib Analyzer', description: 'Inspect archive members, symbols, architectures and import-library metadata.' },
      { id: 'autocomplete', label: 'Autocompletion', description: 'Choose how CVI PM and the native C/C++ provider cooperate for completion and parameter hints.' },
      { id: 'runtime', label: 'Runtime', description: 'CVI runtime support, manifest, map file and LoadExternalModule.' },
      { id: 'dll', label: 'DLL', description: 'DLL copy, import library, exports and type-information resources.' },
      { id: 'version', label: 'Version & Signing', description: 'Windows version resource and signing metadata.' },
      { id: 'build', label: 'Build steps', description: 'Pre-build, custom-build and post-build actions.' },
      { id: 'run', label: 'Run & Debug', description: 'Command line, working directory and DLL host executable.' },
      { id: 'dependencies', label: 'Dependencies', description: 'Project dependencies and build order.' },
      { id: 'diagnostics', label: 'Diagnostics', description: 'Build log detail, Problems integration and trace access.' }
    ];
    const pageNavigation = settingsPages.map((page, index) => `<button type="button" class="page-tab ${index === 0 ? 'active' : ''}" data-settings-page-target="${escapeHtml(page.id)}" title="${escapeHtml(page.description)}">${escapeHtml(page.label)}</button>`).join('');
    const settingsPageMetadata = safeScriptJson(settingsPages);
    const compilerIssuesHtml = compilerIssues.length
      ? compilerIssues.map((issue) => `<div class="notice warning"><strong>${escapeHtml(issue.field)}</strong>: ${escapeHtml(issue.message)}</div>`).join('')
      : '<div class="notice">No compiler-configuration inconsistency detected for this configuration.</div>';
    const dllAnalyzerHtml = renderDllAnalyzerHtml(this.dllAnalyzerPath, this.dllAnalysis);
    const libraryAnalyzerHtml = renderLibraryAnalyzerHtml(this.libraryAnalyzerPath, this.libraryAnalysis);
        return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>CVI Project Settings</title>
<style>
:root{color-scheme:light dark;--cvi-sticky-offset:190px}
*{box-sizing:border-box}
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px;max-width:1440px;margin:auto}
h1{margin:0 0 4px;font-size:26px}h2{font-size:17px;margin:0 0 13px;display:flex;align-items:center;gap:7px}h3{font-size:14px;margin:0 0 10px}.muted,.subtitle{color:var(--vscode-descriptionForeground);line-height:1.45}.path{font-family:var(--vscode-editor-font-family);font-size:12px;overflow-wrap:anywhere;margin-top:4px;color:var(--vscode-descriptionForeground)}code{font-family:var(--vscode-editor-font-family)}
.settings-sticky-header{position:sticky;top:0;z-index:8;background:var(--vscode-editor-background);isolation:isolate;margin-bottom:14px;border-bottom:1px solid var(--vscode-panel-border);box-shadow:0 5px 12px rgba(0,0,0,.08)}
.toolbar{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;padding:10px 0;background:var(--vscode-editor-background)}.toolbar .actions,.actions{display:flex;gap:8px;flex-wrap:wrap}.toolbar .field{min-width:230px}.actions.bottom{justify-content:flex-end;margin-top:16px}
.page-nav{display:flex;gap:4px;overflow-x:auto;overflow-y:hidden;padding:6px 0 8px;scrollbar-width:thin;background:var(--vscode-editor-background)}.page-tab{flex:0 0 auto;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--vscode-descriptionForeground);padding:8px 11px;border-radius:4px 4px 0 0;font-weight:600}.page-tab:hover{background:var(--vscode-toolbar-hoverBackground);color:var(--vscode-foreground)}.page-tab.active{border-bottom-color:var(--vscode-textLink-foreground);background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
.settings-nav{display:grid;grid-template-columns:minmax(220px,1fr) minmax(220px,340px) minmax(180px,auto);gap:10px;align-items:center;padding:8px 0 12px;background:var(--vscode-editor-background)}.page-context{display:flex;flex-direction:column;gap:2px;min-width:0}.page-context strong{font-size:13px}.page-context span{font-size:11px;color:var(--vscode-descriptionForeground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dirty{font-size:12px;color:var(--vscode-descriptionForeground);white-space:nowrap}.dirty.changed{color:var(--vscode-editorWarning-foreground);font-weight:600}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.card{grid-column:1/-1;border:1px solid var(--vscode-panel-border);border-radius:7px;background:var(--vscode-sideBar-background);padding:16px;min-width:0;scroll-margin-top:var(--cvi-sticky-offset)}.card.page-hidden,.card.filter-hidden{display:none!important}.wide{grid-column:1/-1}.fields,.two{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.field,label.field{display:flex;flex-direction:column;gap:5px;margin-top:0;font-weight:600}.field.wide{grid-column:1/-1}.section-body{padding-top:0}.settings-subsection{border-top:1px solid var(--vscode-panel-border);margin-top:14px;padding-top:12px}.settings-subsection:first-child{border-top:0;margin-top:0;padding-top:0}
.control-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}.control-group{border:1px solid var(--vscode-panel-border);border-radius:5px;padding:11px;background:var(--vscode-editorWidget-background)}.control-group h3{font-size:13px;margin:0 0 9px}.control-group .actions{gap:6px}.control-group button{font-size:12px;padding:6px 9px}
.analysis-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px}.analysis-kv{border:1px solid var(--vscode-panel-border);border-radius:4px;padding:8px}.analysis-kv strong{display:block;font-size:12px;color:var(--vscode-descriptionForeground);margin-bottom:3px}.analysis-table{width:100%;border-collapse:collapse;font-size:12px}.analysis-table th,.analysis-table td{border-bottom:1px solid var(--vscode-panel-border);padding:5px 7px;text-align:left;vertical-align:top}.analysis-table th{position:sticky;top:0;background:var(--vscode-editorWidget-background)}.analysis-scroll{max-height:360px;overflow:auto;border:1px solid var(--vscode-panel-border);border-radius:4px}.analysis-badges{display:flex;gap:6px;flex-wrap:wrap}.analysis-badge{border:1px solid var(--vscode-panel-border);border-radius:10px;padding:2px 7px;font-size:11px}.analysis-empty{padding:18px;border:1px dashed var(--vscode-panel-border);color:var(--vscode-descriptionForeground)}
textarea,input,select{width:100%;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);padding:7px 8px;font:inherit;border-radius:2px}textarea{min-height:92px;resize:vertical;font-family:var(--vscode-editor-font-family);font-size:12px}input:focus,select:focus,textarea:focus,button:focus{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}
.dependency{display:grid;grid-template-columns:auto 1fr;gap:2px 8px;padding:7px 0;border-bottom:1px solid var(--vscode-panel-border)}.dependency input,.check input{width:auto;grid-row:1/3;margin:0 6px 0 0}.dependency small{color:var(--vscode-descriptionForeground);overflow-wrap:anywhere}.check{display:block;margin:7px 0;font-weight:400}.notice{margin-top:12px;border:1px solid var(--vscode-panel-border);background:var(--vscode-textBlockQuote-background);padding:10px;border-radius:5px;color:var(--vscode-descriptionForeground);line-height:1.45}.pill-row{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}.pill{border:1px solid var(--vscode-panel-border);border-radius:999px;padding:4px 9px;font-size:12px;color:var(--vscode-descriptionForeground)}
button{border:1px solid var(--vscode-button-border,transparent);background:var(--vscode-button-background);color:var(--vscode-button-foreground);padding:7px 11px;border-radius:3px;cursor:pointer;font:inherit}button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button:not(.page-tab):hover{background:var(--vscode-button-hoverBackground)}button:disabled{opacity:.55;cursor:not-allowed}.path-control{display:grid;grid-template-columns:minmax(0,1fr) 34px;gap:5px;align-items:end}.path-control input{min-width:0}.browse{display:flex;align-items:center;justify-content:center;padding:6px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border-color:var(--vscode-button-border,transparent)}.browse svg{width:16px;height:16px;fill:currentColor}
body:not(.settings-js-ready) [data-settings-section]:not([data-settings-page="overview"]){display:none!important}
.target-dll,.target-exe,.target-static,.target-nonlib{display:none}body[data-target="Dynamic Link Library"] .target-dll{display:block}body[data-target="Executable"] .target-exe{display:block}body[data-target="Static Library"] .target-static{display:block}body:not([data-target="Static Library"]) .target-nonlib{display:block}.target-note{margin-top:8px;padding:8px 10px;border-left:3px solid var(--vscode-textLink-foreground);background:var(--vscode-textBlockQuote-background);color:var(--vscode-descriptionForeground);line-height:1.45}
.module-toolbar{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.module-list{margin-top:10px;border:1px solid var(--vscode-panel-border);border-radius:4px;min-height:48px;max-height:220px;overflow:auto;background:var(--vscode-input-background)}.module-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:8px;padding:7px 8px;border-bottom:1px solid var(--vscode-panel-border);font-family:var(--vscode-editor-font-family);font-size:12px}.module-row:last-child{border-bottom:0}.module-remove{padding:3px 8px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.empty-modules{padding:9px;color:var(--vscode-descriptionForeground);font-family:var(--vscode-font-family)}.warning{color:var(--vscode-editorWarning-foreground)}.conditional-note{display:none}.disabled-zone .conditional-note{display:block}.disabled-zone .section-body{opacity:.62}.disabled-zone summary{opacity:.78}.sub-block{margin-top:11px;padding:12px;border:1px solid var(--vscode-panel-border);border-radius:5px;background:var(--vscode-editor-background)}.sub-block:first-child{margin-top:0}.nested-controls{padding-left:22px}.compact-field{display:grid!important;grid-template-columns:auto 84px;align-items:center;gap:8px;margin:0!important}.compact-field select{margin:0}.disabled-sub-block .nested-controls{opacity:.58}.disabled-control-zone{opacity:.58}.export-headers.disabled-sub-block{opacity:.58}.export-headers.disabled-sub-block .conditional-note{display:block}.dialog-backdrop{position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.42)}.dialog-card{width:min(430px,calc(100vw - 32px));border:1px solid var(--vscode-panel-border);border-radius:7px;background:var(--vscode-editorWidget-background,var(--vscode-editor-background));box-shadow:0 8px 28px rgba(0,0,0,.38);padding:16px}.dialog-card h3{margin:0 0 13px}.dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:15px}.hidden{display:none!important}
@media(max-width:900px){body{padding:14px}.grid,.fields,.two{grid-template-columns:1fr}.wide{grid-column:auto}.settings-sticky-header{position:static;box-shadow:none}.toolbar{align-items:flex-start;flex-direction:column}.settings-nav{grid-template-columns:1fr}.page-context span{white-space:normal}.compact-field{grid-template-columns:1fr}}
</style></head>
<body data-target="${escapeHtml(target.targetType)}">
<h1>CVI Project Settings</h1><div class="subtitle">${escapeHtml(ref.name)} · edited configuration: <strong>${escapeHtml(scopeLabel(mode))}</strong></div><div class="path">${escapeHtml(ref.absolutePath)}</div>
<div id="settingsStickyHeader" class="settings-sticky-header">
  <div class="toolbar"><div><label class="field">Edited build configuration<select id="configurationScope">${scopeOptions(mode, this.customConfigurationNames(ref))}</select></label><div class="muted">${mode === 'all' ? 'The entered values will be applied to Debug, Release, Debug64 and Release64.' : `Only ${escapeHtml(scopeLabel(mode))} will be modified.`}</div></div><div class="actions"><button id="save" type="button">Save settings</button><button data-command="labwindowsCvi.editBuildSettingsSafeMode" class="secondary" type="button">Safe mode</button><button data-command="labwindowsCvi.openWorkspaceInCvi" class="secondary" type="button">Open in CVI</button></div></div>
  <nav id="pageNav" class="page-nav" aria-label="Settings pages">${pageNavigation}</nav>
  <div id="settingsNavigation" class="settings-nav"><input id="settingsFilter" type="search" placeholder="Filter settings on this page…" aria-label="Filter current settings page"><select id="sectionNav" aria-label="Jump to a section"><option value="">Jump to a section…</option></select><div class="page-context"><strong id="pageTitle">Overview</strong><span id="pageDescription">Project status and common CVI actions.</span><span id="dirtyState" class="dirty">Saved state</span></div></div>
</div>
<div class="grid">
<section id="section-control" data-settings-section data-settings-page="overview" data-settings-title="Control center" class="card wide"><h2>Project control center</h2><div class="control-grid"><div class="control-group"><h3>Build and run</h3><div class="actions"><button data-command="labwindowsCvi.build">Build</button><button data-command="labwindowsCvi.rebuild">Rebuild</button><button data-command="labwindowsCvi.clean">Clean</button><button data-command="labwindowsCvi.run">Run</button><button data-command="labwindowsCvi.buildAndRun">Build + run</button></div></div><div class="control-group"><h3>CVI native tools</h3><div class="actions"><button data-command="labwindowsCvi.openWorkspaceInCvi">Open in CVI</button><button data-command="labwindowsCvi.debugInCvi">Debug in CVI</button><button data-command="labwindowsCvi.configureInstallation">CVI path</button></div></div><div class="control-group"><h3>IntelliSense</h3><div class="actions"><button data-command="labwindowsCvi.syncCppTools">Sync</button><button data-command="labwindowsCvi.diagnoseCppTools">Diagnose</button></div></div><div class="control-group"><h3>Import libraries</h3><div class="actions"><button data-command="labwindowsCvi.generateImportLibraryFromHeaders">Header(s) → .lib</button><button data-command="labwindowsCvi.generateImportLibraryFromDll">DLL → .lib</button><button data-settings-page-target="libraries">Library tools</button></div></div><div class="control-group"><h3>DLL Analyzer</h3><div class="actions"><button data-settings-page-target="dllAnalyzer">Open analyzer</button><button data-command="labwindowsCvi.analyzeDll">Analyze DLL…</button></div></div><div class="control-group"><h3>.a / .lib Analyzer</h3><div class="actions"><button data-settings-page-target="libraryAnalyzer">Open analyzer</button><button data-command="labwindowsCvi.analyzeLibrary">Analyze library…</button></div></div><div class="control-group"><h3>Diagnostics</h3><div class="actions"><button data-command="labwindowsCvi.showBuildProblems">Problems</button><button data-command="labwindowsCvi.showFullBuildTrace">Build Trace</button></div></div></div><div class="notice">This editor is organized by thematic pages. Use the page bar for broad areas and <code>Jump to a section...</code> for local navigation.</div></section>
<section id="section-native-storage" data-settings-section data-settings-page="project" data-settings-title="Native project storage" class="card wide"><h2>Native project storage</h2><p class="muted">Native target settings are read from and written to the selected CVI <code>.prj</code> configuration. A timestamped backup is created before every native write. Project dependencies remain mirrored in <code>.vscode/labwindows-cvi-build.json</code> until a non-empty CVI dependency reference sample is available.</p><div class="pill-row"><span class="pill">Project: ${escapeHtml(ref.name)}</span><span class="pill">Scope: ${escapeHtml(scopeLabel(mode))}</span><span class="pill">Target: ${escapeHtml(target.targetType)}</span></div></section>
<section id="section-target" data-settings-section data-settings-page="project" data-settings-title="Target and output" class="card wide"><h2>Target and output</h2><div class="fields"><label class="field">Target type<select id="targetType">${targetOption('Executable', target.targetType)}${targetOption('Dynamic Link Library', target.targetType)}${targetOption('Static Library', target.targetType)}</select></label>${pathField('Output file', 'outputPath', target.outputPath)}</div><p class="muted">The output path applies to ${escapeHtml(scopeLabel(mode))} and is stored in the native CVI project file.</p><div class="target-note target-exe">Executable target: run/debug command-line options and executable metadata are active.</div><div class="target-note target-dll">DLL target: DLL copy, import-library, export and type-information options are active. Run options use an external host executable.</div><div class="target-note target-static">Static library target: runtime, DLL and executable launch options are not used.</div></section>
<section id="section-compiler-core" data-settings-section data-settings-page="compiler" data-settings-title="Compiler configuration" class="card wide"><h2>Compiler configuration</h2><p class="muted">These values are stored in the native CVI configuration <code>${escapeHtml(scopeLabel(mode))}</code>. For All Standard Configurations, the entered values are applied to Debug, Release, Debug64 and Release64.</p><div class="two">${textField('Default calling convention','defaultCallingConvention',compiler.defaultCallingConvention)}<label class="field">Uninitialized locals warning<select id="uninitializedLocalsCompileWarning">${selectOptions([['Conservative','Conservative'],['Aggressive','Aggressive']],compiler.uninitializedLocalsCompileWarning)}</select></label><label class="field wide">Compiler defines<textarea id="compilerDefines">${escapeHtml(compiler.compilerDefines)}</textarea></label><label class="field wide">Project include paths (one per line)<textarea id="includePaths">${escapeHtml(projectCompiler.includePaths.join('\n'))}</textarea></label></div><div class="inline"><label class="check"><input id="requirePrototypes" type="checkbox" ${checked(compiler.requirePrototypes)}> Require prototypes</label><label class="check"><input id="requireReturnValues" type="checkbox" ${checked(compiler.requireReturnValues)}> Require return values</label><label class="check"><input id="enableC99Extensions" type="checkbox" ${checked(compiler.enableC99Extensions)}> Enable C99 extensions</label><label class="check"><input id="enablePointerMismatchWarning" type="checkbox" ${checked(compiler.enablePointerMismatchWarning)}> Pointer mismatch warning</label><label class="check"><input id="enableUnreachableCodeWarning" type="checkbox" ${checked(compiler.enableUnreachableCodeWarning)}> Unreachable code warning</label><label class="check"><input id="enableUnreferencedIdentifiersWarning" type="checkbox" ${checked(compiler.enableUnreferencedIdentifiersWarning)}> Unreferenced identifiers warning</label><label class="check"><input id="enableAssignmentInConditionalWarning" type="checkbox" ${checked(compiler.enableAssignmentInConditionalWarning)}> Assignment in conditional warning</label></div></section>
<section id="section-compiler-modern" data-settings-section data-settings-page="compiler" data-settings-title="Generation-specific compiler options" class="card wide"><h2>Generation-specific compiler options</h2><p class="muted">CVI generations do not serialize every option the same way. CVI PM edits the following fields only when the selected native project configuration already stores them; unsupported fields remain disabled instead of injecting newer keys into an older <code>.prj</code>.</p><div class="two"><label class="field">Optimization level<input id="optimizationLevel" value="${escapeHtml(compiler.optimizationLevel)}" ${compiler.supportsOptimizationLevel ? '' : 'disabled'} placeholder="Not stored by this project generation"></label><label class="field">Selected warning level<input id="selectedWarningLevel" value="${escapeHtml(compiler.selectedWarningLevel)}" ${compiler.supportsWarningProfile ? '' : 'disabled'} placeholder="Not stored by this project generation"></label><label class="field">Warning mode<input id="warningMode" value="${escapeHtml(compiler.warningMode)}" ${compiler.supportsWarningProfile ? '' : 'disabled'}></label><label class="check"><input id="showWarningIdsInBuildOutput" type="checkbox" ${checked(compiler.showWarningIdsInBuildOutput)} ${compiler.supportsWarningProfile ? '' : 'disabled'}> Show warning IDs in build output</label><label class="check"><input id="enableOpenMpExtensions" type="checkbox" ${checked(compiler.enableOpenMpExtensions)} ${compiler.supportsOpenMp ? '' : 'disabled'}> Enable OpenMP extensions</label></div></section>
<section id="section-linker-memory" data-settings-section data-settings-page="compiler" data-settings-title="Linker and memory" class="card wide"><h2>Linker and memory</h2><div class="two">${textField('Stack size','stackSize',compiler.stackSize)}${textField('Image base address x86','imageBaseAddress',compiler.imageBaseAddress)}${textField('Image base address x64','imageBaseAddress64',compiler.imageBaseAddress64)}<label class="field">Stack reserve<input id="stackReserve" value="${escapeHtml(compiler.stackReserve)}" ${compiler.supportsStackReserveCommit ? '' : 'disabled'} placeholder="Not stored by this project generation"></label><label class="field">Stack commit<input id="stackCommit" value="${escapeHtml(compiler.stackCommit)}" ${compiler.supportsStackReserveCommit ? '' : 'disabled'} placeholder="Not stored by this project generation"></label></div><div class="inline"><label class="check"><input id="oOptionCompatibleWith50" type="checkbox" ${checked(projectCompiler.oOptionCompatibleWith50)}> O option compatible with CVI 5.0</label><label class="check"><input id="precompilePrefixHeader" type="checkbox" ${checked(projectCompiler.precompilePrefixHeader)}> Precompile prefix header</label></div>${textField('Prefix header file','prefixHeaderFile',projectCompiler.prefixHeaderFile)}</section>
${workspaceBuild ? `<section id="section-workspace-build" data-settings-section data-settings-page="compiler" data-settings-title="Workspace build and debug options" class="card wide"><h2>Workspace build and debug options</h2><p class="muted">Stored in the current <code>.cws</code> for project ${escapeHtml(ref.name)} and configuration ${escapeHtml(scopeLabel(mode))}.</p><div class="two">${textField('Debugging level','debuggingLevel',workspaceBuild.debuggingLevel)}${textField('Profile','profile',workspaceBuild.profile)}${textField('Execution trace','executionTrace',workspaceBuild.executionTrace)}</div><div class="inline"><label class="check"><input id="generateBrowseInfo" type="checkbox" ${checked(workspaceBuild.generateBrowseInfo)}> Generate browse info</label><label class="check"><input id="enableUninitializedLocalsRuntimeWarning" type="checkbox" ${checked(workspaceBuild.enableUninitializedLocalsRuntimeWarning)}> Runtime warning for uninitialized locals</label><label class="check"><input id="batchBuild" type="checkbox" ${checked(workspaceBuild.batchBuild)}> Batch build</label><label class="check"><input id="breakOnLibraryErrors" type="checkbox" ${checked(workspaceBuild.breakOnLibraryErrors)}> Break on library errors</label><label class="check"><input id="breakOnFirstChanceExceptions" type="checkbox" ${checked(workspaceBuild.breakOnFirstChanceExceptions)}> Break on first-chance exceptions</label></div></section>` : ''}
<section id="section-compiler-validation" data-settings-section data-settings-page="compiler" data-settings-title="Compiler configuration validation" class="card wide"><h2>Compiler configuration validation</h2>${compilerIssuesHtml}</section>
<section id="section-external-compiler" data-settings-section data-settings-page="external" data-settings-title="External compiler" class="card wide"><h2>External compiler</h2><p class="muted">The build engine is a CVI PM project setting. <strong>Native CVI</strong> continues to invoke <code>compile.exe</code>. <strong>Microsoft Visual C++</strong> compiles the C sources directly with <code>cl.exe</code> and links against the CVI external support libraries. NI still requires the CVI Runtime initialization and any UIR callback support files needed by the project.</p><div class="two"><label class="field">Build engine<select id="externalBuildEngine">${selectOptions([['cvi','Native LabWindows/CVI (compile.exe)'],['msvc','External Microsoft Visual C++ (MSVC)']],settings.externalBuild.engine)}</select></label><div class="target-dll">${selectField('External DLL import-library outputs','externalDllImportLibraryFormat',settings.externalBuild.dllImportLibraryFormat,[['auto','Automatic — Windows .lib for MSVC'],['windows-lib','Windows import library (.lib)'],['gnu-dll-a','GNU/MinGW import library (.dll.a)'],['gnu-a','GNU/MinGW import library (.a) — legacy name'],['gnu-both','Generate both GNU names (.dll.a + .a)'],['both','Generate .dll.a + .lib'],['gnu-a-windows-lib','Generate .a + .lib'],['all','Generate all (.dll.a + .a + .lib)'],['none','Do not generate an import library']])}</div>${textField('vcvarsall.bat override (optional)','externalVcvarsallPath',settings.externalBuild.vcvarsallPath)}${textField('External build directory (optional)','externalBuildDirectory',settings.externalBuild.buildDirectory)}<label class="field wide">Additional compiler options<input id="externalCompilerOptions" value="${escapeHtml(settings.externalBuild.additionalCompilerOptions)}" placeholder="Example: /DTESTBENCH /wd4996"></label><label class="field wide">Additional linker options<input id="externalLinkerOptions" value="${escapeHtml(settings.externalBuild.additionalLinkerOptions)}" placeholder="Example: /SUBSYSTEM:WINDOWS"></label><label class="field wide">Additional libraries (one path/name per line)<textarea id="externalLibraries">${escapeHtml(settings.externalBuild.additionalLibraries.join('\n'))}</textarea></label></div><div class="inline"><label class="check"><input id="externalUseCviSupport" type="checkbox" ${checked(settings.externalBuild.useCviExternalSupportFiles)}> Use generated CVI External Compiler Support files when available</label><label class="check"><input id="externalDebugVsCode" type="checkbox" ${checked(settings.externalBuild.debugInVsCode)}> Enable VS Code <code>cppvsdbg</code> launch for Debug builds</label></div><div class="control-group"><h3>Native CVI External Compiler Support metadata</h3><div class="path">UIR callback file: ${escapeHtml(externalSupport.uirCallbacksObjFile || '<not generated>')}</div><div class="path">Project symbols object: ${escapeHtml(externalSupport.projectSymbolsObjFile || '<not generated>')}</div><div class="muted">These files are generated by LabWindows/CVI Build > External Compiler Support. CVI PM consumes them when present; it does not attempt to reverse-engineer UIR callback tables.</div></div><div class="notice warning"><strong>Debug distinction:</strong> an external compiler does not make the binary debuggable by the CVI debugger. CVI uses its own compiler for debuggable code. External MSVC Debug instead produces PDB symbols so the executable/DLL can be debugged directly in VS Code.</div><div class="actions"><button data-command="labwindowsCvi.externalBuild" type="button">Build with selected engine</button><button data-command="labwindowsCvi.externalDebug" class="secondary" type="button">Build + Debug in VS Code</button><button data-command="labwindowsCvi.debugWithoutBuild" class="secondary" type="button">Debug Active Target</button></div></section>
<section id="section-import-libraries" data-settings-section data-settings-page="libraries" data-settings-title="Windows import-library generation" class="card wide"><h2>Windows import-library generation</h2><div class="fields">${selectField('Generator','importLibraryGenerator',settings.importLibraries.generator,[['auto','Automatic — detect compatible generator'],['gnu-dlltool','GNU dlltool — MinGW/GCC'],['llvm-dlltool','LLVM llvm-dlltool'],['msvc-lib','Microsoft lib.exe'],['llvm-lib','LLVM llvm-lib']])}${pathField('Generator executable override','importLibraryGeneratorPath',settings.importLibraries.generatorPath)}${selectField('Header target architecture','importLibraryArchitecture',settings.importLibraries.architecture,[['auto','Automatic — derive from active CVI build mode'],['x86','x86 / 32-bit'],['x64','x64 / 64-bit'],['arm64','ARM64']])}${textField('Default output directory','importLibraryOutputDirectory',settings.importLibraries.outputDirectory,'lib')}<label class="check wide"><input id="importLibraryKeepDefinitionFile" type="checkbox" ${checked(settings.importLibraries.keepDefinitionFile)}> Keep the generated <code>.def</code> file beside the <code>.lib</code></label></div><div class="actions"><button data-command="labwindowsCvi.generateImportLibraryFromHeaders">Generate .lib from Header(s)...</button><button data-command="labwindowsCvi.generateImportLibraryFromDll">Generate .lib from DLL(s)...</button><button data-command="labwindowsCvi.extractDllDefinitionFile" class="secondary">Extract DLL exports (.def)...</button><button data-command="labwindowsCvi.openImportLibraryReport" class="secondary">Open last report</button></div><div class="notice"><strong>Header(s) → .lib</strong> creates a Windows <em>import library</em>; it does not reconstruct a static-library implementation, so the matching DLL is still required at runtime. Header-based symbol names are most reliable for C / <code>extern &quot;C&quot;</code> APIs. <strong>DLL → .lib</strong> reads the actual PE export table, including decorated C++ names.</div><p class="muted">These tools are independent from CVI native <strong>DLL Target Settings</strong>. The native <code>.prj</code> remains authoritative for CVI's own DLL import-library behavior; this page provides portable generation/analyzer tools and output formats for the external build backend.</p></section>
<section id="section-dll-analyzer" data-settings-section data-settings-page="dllAnalyzer" data-settings-title="DLL Analyzer" class="card wide"><h2>DLL Analyzer</h2>${dllAnalyzerHtml}</section>
<section id="section-library-analyzer" data-settings-section data-settings-page="libraryAnalyzer" data-settings-title=".a / .lib archive analyzer" class="card wide"><h2>.a / .lib Analyzer</h2>${libraryAnalyzerHtml}</section>
<section id="section-autocomplete-profile" data-settings-section data-settings-page="autocomplete" data-settings-title="Autocompletion profile" class="card wide"><h2>Autocompletion profile</h2><p class="muted">These settings apply to the current VS Code workspace and are independent from the selected CVI Debug/Release configuration. CVI PM never disables or rewrites the Microsoft C/C++ provider; Native modes simply withdraw CVI PM contributions.</p><div class="two"><label class="field">Profile<select id="autocompleteProfile">${selectOptions([['hybrid','Hybrid — CVI PM + native provider'],['native','Native — native C/C++ provider only'],['nativeSignature','Native + CVI Signature Help'],['cviApi','CVI API Assist'],['custom','Custom']],autocompleteProfile)}</select></label><div class="control-group"><h3>Effective behavior</h3><div id="autocompleteEffective" class="pill-row"></div><div id="autocompleteProfileDescription" class="muted"></div></div></div><div class="actions"><button id="saveAutocomplete" type="button">Save settings</button><button id="resetAutocompleteHybrid" class="secondary" type="button">Reset to Hybrid</button><button data-command="labwindowsCvi.syncCppTools" class="secondary" type="button">Sync IntelliSense</button><button data-command="labwindowsCvi.diagnoseCppTools" class="secondary" type="button">Diagnose IntelliSense</button></div></section>
<section id="section-autocomplete-custom" data-settings-section data-settings-page="autocomplete" data-settings-title="Custom autocompletion components" class="card wide"><h2>Custom components</h2><p class="muted">These switches are used only when the profile is <strong>Custom</strong>. They let you decide exactly which assistance CVI PM adds on top of the native C/C++ extension.</p><div id="autocompleteCustomOptions" class="control-grid"><label class="control-group check"><input id="autocompleteCompletionEnabled" type="checkbox" ${checked(autocompleteCustom.completionEnabled)}> <strong>CVI PM completion provider</strong><div class="muted">Master switch for CVI PM completion items.</div></label><label class="control-group check"><input id="autocompleteProjectSymbols" type="checkbox" ${checked(autocompleteCustom.includeProjectCompletion)}> <strong>Project symbols</strong><div class="muted">Functions discovered in the active CVI project headers and sources.</div></label><label class="control-group check"><input id="autocompleteCviApi" type="checkbox" ${checked(autocompleteCustom.includeCviApiCompletion)}> <strong>LabWindows/CVI API</strong><div class="muted">Functions from the embedded CVI API pack.</div></label><label class="control-group check"><input id="autocompleteSignatureHelp" type="checkbox" ${checked(autocompleteCustom.signatureHelpEnabled)}> <strong>Immediate Signature Help</strong><div class="muted">Show prototypes and active parameters immediately after <code>(</code> and <code>,</code>.</div></label></div><div class="notice">Recommended when Microsoft C/C++ already indexes the project correctly: <strong>Native + CVI Signature Help</strong>. It avoids duplicate project completion entries while keeping immediate parameter hints from CVI PM.</div></section>
<section id="section-target-creation" data-settings-section data-settings-page="runtime" data-settings-title="Target creation options" class="card wide target-nonlib"><h2>Target creation options</h2><div class="section-body"><div class="two"><label class="field target-exe">Application title<input id="applicationTitle" value="${escapeHtml(target.applicationTitle)}"></label><div class="target-exe">${pathField('Application icon file', 'iconFile', target.iconFile)}</div>${selectField('Run-time support', 'runtimeSupport', target.runtimeSupport, RUNTIME_SUPPORT_OPTIONS)}${selectField('Run-time engine binding', 'runtimeBinding', target.runtimeBinding, runtimeBindingOptions)}${selectField('Generate help from source', 'generateSourceDocumentation', target.generateSourceDocumentation, SOURCE_DOCUMENTATION_OPTIONS)}<div id="manifestPathRow">${pathField('Manifest file', 'manifestPath', target.manifestPath)}</div></div><div class="inline"><label class="check"><input id="manifestEmbed" type="checkbox" ${checked(target.manifestEmbed)}> Embed manifest</label><label class="check"><input id="embedProjectUirs" type="checkbox" ${checked(target.embedProjectUirs)}> Embed project .UIRs</label><label class="check"><input id="generateMapFile" type="checkbox" ${checked(target.generateMapFile)}> Generate map file</label><label class="check target-exe"><input id="createConsoleApplication" type="checkbox" ${checked(target.createConsoleApplication)}> Create console application</label><label class="check"><input id="embedTimestamp" type="checkbox" ${checked(target.embedTimestamp)}> Embed timestamp</label></div></div></section>
<section id="loadExternalModuleSection" data-settings-section data-settings-page="runtime" data-settings-title="LoadExternalModule options" class="card wide target-nonlib"><h2>LoadExternalModule options</h2><div class="section-body"><p class="muted warning">Compatibility option retained by CVI. Enable the option, then add <code>.lib</code> or <code>.obj</code> modules. The preview is saved in the native <code>[Modules Forced Into Executable]</code> section.</p><p class="muted warning conditional-note">Unavailable when run-time support is set to Instrument driver only.</p><label class="check"><input id="usingLoadExternalModule" type="checkbox" ${checked(target.usingLoadExternalModule)}> Enable LoadExternalModule</label><input id="forcedModules" type="hidden" value="${escapeHtml(target.forcedModules.join('\n'))}"><div class="module-toolbar"><button id="addForcedModules" class="secondary" type="button">Add files to ${target.targetType === 'Dynamic Link Library' ? 'DLL' : 'executable'}…</button><button id="addForcedModuleName" class="secondary" type="button">Add module name…</button></div><div id="forcedModulesPreview" class="module-list"></div></div></section>
<section id="section-dll-options" data-settings-section data-settings-page="dll" data-settings-title="DLL copy, import library and exports" class="card wide target-dll"><h2>DLL copy, import library and exports</h2><div class="section-body"><div class="two"><div id="customDirectoryToCopyDllRow">${pathField('Custom copy directory', 'customDirectoryToCopyDll', target.customDirectoryToCopyDll)}</div>${selectField('Where to copy DLL', 'whereToCopyDll', target.whereToCopyDll, DLL_COPY_OPTIONS)}<label class="field">DLL import library choice<input id="dllImportLibraryChoice" value="${escapeHtml(target.dllImportLibraryChoice)}" placeholder="Native CVI value"></label><label id="importLibBaseNameRow" class="field">Import library base name<input id="importLibBaseName" value="${escapeHtml(target.importLibBaseName)}"></label>${selectField('Export mode', 'dllExports', target.dllExports, DLL_EXPORT_OPTIONS)}</div><div class="inline"><label class="check"><input id="useDefaultImportLibBaseName" type="checkbox" ${checked(target.useDefaultImportLibBaseName)}> Use default import library base name</label><button id="openImportLibraryChoices" class="secondary" type="button">Import library choices…</button><span id="importLibraryChoicesSummary" class="muted"></span></div><div id="dllExportHeadersBlock" class="export-headers settings-subsection"><h3>Headers included in DLL exports</h3><p class="muted conditional-note">Unavailable when export mode is Symbols marked for export.</p>${exportFileChecks}</div></div></section>
<div id="importLibraryChoicesDialog" class="dialog-backdrop hidden" role="dialog" aria-modal="true" aria-labelledby="importLibraryChoicesTitle"><div class="dialog-card"><h3 id="importLibraryChoicesTitle">DLL Import Library Choices</h3><label class="check"><input id="useIviSubdirectoriesForImportLibraries" type="checkbox" ${checked(target.useIviSubdirectoriesForImportLibraries)}> Use IVI subdirectories</label><label class="check"><input id="useVxiPnpSubdirectoriesForImportLibraries" type="checkbox" ${checked(target.useVxiPnpSubdirectoriesForImportLibraries)}> Use VXIplug&amp;play subdirectories</label><div class="dialog-actions"><button id="confirmImportLibraryChoices" type="button">OK</button><button id="cancelImportLibraryChoices" class="secondary" type="button">Cancel</button></div></div></div>
<section id="section-dll-typeinfo" data-settings-section data-settings-page="dll" data-settings-title="DLL type information" class="card wide target-dll"><h2>DLL type information</h2><div class="section-body"><div id="typeLibraryResourceBlock" class="sub-block"><label class="check"><input id="addTypeLibToDll" type="checkbox" ${checked(target.addTypeLibToDll)}> Add type library resource to DLL</label><div class="nested-controls"><div class="inline"><label class="check"><input id="includeTypeLibHelpLinks" type="checkbox" ${checked(target.includeTypeLibHelpLinks)}> Include links to help file</label><label class="field compact-field">TLB help file<select id="tlbHelpStyle">${selectOptions(TLB_HELP_STYLE_OPTIONS, target.tlbHelpStyle)}</select></label></div><div id="typeLibFpFileRow">${pathField('Function panel file', 'typeLibFpFile', target.typeLibFpFile)}</div></div></div><div id="niTypeInfoResourceBlock" class="sub-block"><label class="check"><input id="addNiTypeInfoToDll" type="checkbox" ${checked(target.addNiTypeInfoToDll)}> Add NI Type Information resource to DLL</label><div class="nested-controls"><label class="check"><input id="niTypeInfoFromAllSources" name="niTypeInfoSource" type="radio" value="all" ${checked(!target.useSingleHeaderForNiTypeInfo)}> Data from all source files</label><label class="check"><input id="niTypeInfoFromSingleHeader" name="niTypeInfoSource" type="radio" value="single" ${checked(target.useSingleHeaderForNiTypeInfo)}> Data from single header file</label><div id="singleHeaderNiTypeInfoRow">${pathField('Header file', 'singleHeaderNiTypeInfoFile', target.singleHeaderNiTypeInfoFile)}</div></div></div></div></section>
<section id="section-version" data-settings-section data-settings-page="version" data-settings-title="Version information" class="card wide"><h2>Version information</h2><div class="section-body two">${textField('Numeric file version', 'numericFileVersion', target.versionInfo.numericFileVersion)}${textField('Numeric product version', 'numericProductVersion', target.versionInfo.numericProductVersion)}${textField('Comments', 'versionComments', target.versionInfo.comments)}${textField('Company name', 'companyName', target.versionInfo.companyName)}${textField('File description', 'fileDescription', target.versionInfo.fileDescription)}${textField('File version', 'fileVersion', target.versionInfo.fileVersion)}${textField('Internal name', 'internalName', target.versionInfo.internalName)}${textField('Legal copyright', 'legalCopyright', target.versionInfo.legalCopyright)}${textField('Legal trademarks', 'legalTrademarks', target.versionInfo.legalTrademarks)}${textField('Original filename', 'originalFilename', target.versionInfo.originalFilename)}${textField('Private build', 'privateBuild', target.versionInfo.privateBuild)}${textField('Product name', 'productName', target.versionInfo.productName)}${textField('Product version', 'productVersion', target.versionInfo.productVersion)}${textField('Special build', 'specialBuild', target.versionInfo.specialBuild)}</div></section>
<section id="section-signing" data-settings-section data-settings-page="version" data-settings-title="Signing information" class="card wide target-nonlib"><h2>Signing information</h2><div class="section-body"><label class="check"><input id="signEnabled" type="checkbox" ${checked(target.signing.enabled)}> Sign target</label><div id="signingDetailsBlock" class="nested-controls"><label class="check"><input id="signDebugBuild" type="checkbox" ${checked(target.signing.signDebugBuild)}> Sign debug build</label><div class="two">${textField('Certificate store', 'signStore', target.signing.store)}${textField('Certificate', 'signCertificate', target.signing.certificate)}${textField('Timestamp URL', 'signTimestampUrl', target.signing.timestampUrl)}${textField('Description URL', 'signDescriptionUrl', target.signing.descriptionUrl)}</div></div></div></section>
<section id="section-build-actions" data-settings-section data-settings-page="build" data-settings-title="Build actions" class="card wide"><h2>Build actions</h2>${customName ? `<div class="notice">Named configuration <strong>${escapeHtml(customName)}</strong> is built with <code>compile.exe -config=${escapeHtml(customName)}</code>. Its native Build Steps remain owned by CVI/compile.exe and are not duplicated or rewritten by this editor.</div>` : `<div class="section-body two"><label class="field">Pre-build actions<textarea id="preBuildActions">${escapeHtml(settings.preBuildActions.join('\n'))}</textarea></label><label class="field">Custom build actions<textarea id="customBuildActions">${escapeHtml(settings.customBuildActions.join('\n'))}</textarea></label><label class="field wide">Post-build actions<textarea id="postBuildActions">${escapeHtml(settings.postBuildActions.join('\n'))}</textarea></label></div>`}</section>
${customName && !customWorkspaceSerialized ? `<div class="notice warning"><strong>${escapeHtml(customName)}</strong> is recognized in the <code>.prj</code>, but the current <code>.cws</code> does not contain a matching serialized <code>Default Build Config ... ${escapeHtml(customName)}</code> section. Run/Debug workspace fields below use the ${escapeHtml(scopeLabel(representativeMode))} fallback and are read-only until CVI serializes the custom workspace configuration.</div>` : ''}
<section id="runOptionsSection" data-settings-section data-settings-page="run" data-settings-title="Run and debug command line" class="card wide target-nonlib"><h2>Run and debug command line</h2><div class="fields"><div id="externalProcessPathRow">${pathField('Program name','externalProcessPath',target.targetType === 'Dynamic Link Library' ? settings.run.externalProcessPath : target.outputPath)}</div>${textField('Command line arguments','arguments',settings.run.arguments,'--option value')}${pathField('Working directory','workingDirectory',settings.run.workingDirectory)}${textField('Environment options','environmentOptions',settings.run.environmentOptions,'NAME=value;OTHER=value')}</div><p class="muted target-exe">Executable target: Program Name is the built output executable. The field is read-only, matching LabWindows/CVI.</p><p class="muted target-dll">DLL target: Program Name is editable and selects the executable that loads or uses the DLL. Run builds the DLL, then launches this program with the configured command-line arguments.</p></section>
<section id="section-dependencies" data-settings-section data-settings-page="dependencies" data-settings-title="Project dependencies and build order" class="card wide"><h2>Project dependencies and build order</h2><p class="muted">Checked projects are built before ${escapeHtml(ref.name)}.</p>${dependencies}</section>
<section id="section-log" data-settings-section data-settings-page="diagnostics" data-settings-title="Build logs and Problems" class="card wide"><h2>Build logs and Problems</h2><div class="fields">${selectField('Build log detail', 'buildLogDetail', buildLogDetail, logDetailOptions)}</div><p class="muted">The main <code>LabWindows/CVI</code> channel is the structured human-readable build report. Full raw commands, stdout, stderr, exit codes and timings remain available in <code>LabWindows/CVI - Build Trace</code>. Build diagnostics are also sent to <code>View → Problems</code> when CVI/compiler output can be parsed.</p><div class="actions"><button data-command="labwindowsCvi.showBuildProblems">Show Build Problems</button><button data-command="labwindowsCvi.showFullBuildTrace">Show Full Build Trace</button></div></section>
</div><div class="actions bottom"><button id="saveBottom" type="button">Save CVI settings</button></div>
<script>
const vscode=(window.__cviVsCodeApi||(window.__cviVsCodeApi=acquireVsCodeApi()));document.body.classList.add('settings-js-ready');const settingsPages=${settingsPageMetadata};const el=(id)=>document.getElementById(id);const val=(id)=>el(id)?.value||'';const flag=(id)=>!!el(id)?.checked;const lines=(id)=>val(id).replaceAll(String.fromCharCode(13),'').split(String.fromCharCode(10)).map(v=>v.trim()).filter(Boolean);const chosen=(selector)=>[...document.querySelectorAll(selector+':checked')].map(e=>e.value);let forcedModules=${JSON.stringify(target.forcedModules)};const customWorkspaceSerialized=${customWorkspaceSerialized ? 'true' : 'false'};const customScopeActive=${customName ? 'true' : 'false'};
const autocompleteProfiles={hybrid:{completion:true,project:true,cvi:true,signature:true,description:'CVI PM adds project symbols, LabWindows/CVI API symbols and immediate parameter hints. Other C/C++ providers can also contribute completion entries.'},native:{completion:false,project:false,cvi:false,signature:false,description:'CVI PM withdraws completion and Signature Help. The installed native C/C++ provider remains untouched.'},nativeSignature:{completion:false,project:false,cvi:false,signature:true,description:'Completion stays native while CVI PM provides immediate function prototypes and parameter hints.'},cviApi:{completion:true,project:false,cvi:true,signature:true,description:'Project completion stays native; CVI PM adds the embedded LabWindows/CVI API plus immediate Signature Help.'}};
const autocompleteEffectiveState=()=>{const profile=val('autocompleteProfile')||'hybrid';if(profile==='custom')return{completion:flag('autocompleteCompletionEnabled'),project:flag('autocompleteProjectSymbols'),cvi:flag('autocompleteCviApi'),signature:flag('autocompleteSignatureHelp'),description:'Custom profile: the switches below define exactly what CVI PM contributes.'};return autocompleteProfiles[profile]||autocompleteProfiles.hybrid;};
const updateAutocompleteControls=()=>{const profile=val('autocompleteProfile')||'hybrid';const custom=profile==='custom';const customHost=el('autocompleteCustomOptions');if(customHost){customHost.querySelectorAll('input').forEach(input=>input.disabled=!custom);customHost.style.opacity=custom?'1':'.62';}const state=autocompleteEffectiveState();const pills=[];pills.push('<span class="pill">CVI PM completion: '+(state.completion?'On':'Off')+'</span>');pills.push('<span class="pill">Project symbols: '+(state.completion&&state.project?'On':'Off')+'</span>');pills.push('<span class="pill">CVI API: '+(state.completion&&state.cvi?'On':'Off')+'</span>');pills.push('<span class="pill">Signature Help: '+(state.signature?'On':'Off')+'</span>');if(el('autocompleteEffective'))el('autocompleteEffective').innerHTML=pills.join('');if(el('autocompleteProfileDescription'))el('autocompleteProfileDescription').textContent=state.description;};
const bindingOptions={"Executable":${JSON.stringify(EXE_RUNTIME_BINDING_OPTIONS)},"Dynamic Link Library":${JSON.stringify(DLL_RUNTIME_BINDING_OPTIONS)},"Static Library":[]};
const pageButtons=[...document.querySelectorAll('[data-settings-page-target]')];const sections=[...document.querySelectorAll('[data-settings-section]')];const sectionNav=el('sectionNav');const settingsFilter=el('settingsFilter');const pageTitle=el('pageTitle');const pageDescription=el('pageDescription');const dirtyState=el('dirtyState');let webviewState=(vscode&&typeof vscode.getState==='function'?vscode.getState():{})||{};const requestedPage=${safeScriptJson(this.selectedPage || '')};let activePage=settingsPages.some(page=>page.id===requestedPage)?requestedPage:(settingsPages.some(page=>page.id===webviewState.activePage)?webviewState.activePage:'overview');
const markDirty=()=>{if(dirtyState){dirtyState.textContent='Unsaved changes';dirtyState.classList.add('changed');}};const markSaved=()=>{if(dirtyState){dirtyState.textContent='Saved state';dirtyState.classList.remove('changed');}};
const populateSections=()=>{if(!sectionNav)return;sectionNav.innerHTML='<option value="">Jump to a section…</option>';sections.filter(section=>section.dataset.settingsPage===activePage&&!section.classList.contains('page-hidden')&&!section.classList.contains('filter-hidden')).forEach(section=>{const option=document.createElement('option');option.value=section.id;option.textContent=section.dataset.settingsTitle||section.id;sectionNav.appendChild(option);});};
const applyFilter=()=>{const query=(settingsFilter?.value||'').trim().toLowerCase();sections.forEach(section=>{const belongs=section.dataset.settingsPage===activePage;section.classList.toggle('page-hidden',!belongs);const text=((section.dataset.settingsTitle||'')+' '+section.textContent).toLowerCase();section.classList.toggle('filter-hidden',belongs&&!!query&&!text.includes(query));});populateSections();};
const activatePage=(pageId,scrollToTop=false)=>{const meta=settingsPages.find(page=>page.id===pageId)||settingsPages[0];activePage=meta.id;pageButtons.forEach(button=>{const selected=button.dataset.settingsPageTarget===activePage;button.classList.toggle('active',selected);button.setAttribute('aria-current',selected?'page':'false');});if(pageTitle)pageTitle.textContent=meta.label;if(pageDescription)pageDescription.textContent=meta.description;webviewState={...webviewState,activePage};if(vscode&&typeof vscode.setState==='function')vscode.setState(webviewState);applyFilter();if(scrollToTop)document.getElementById('settingsStickyHeader')?.scrollIntoView({block:'start'});};
const replaceOptions=(id,options)=>{const select=el(id);if(!select)return;const previous=select.value;select.innerHTML='';const values=[...options];if(previous&&!values.some(v=>v[0]===previous))values.push([previous,previous+' (existing value)']);for(const option of values){const node=document.createElement('option');node.value=option[0];node.textContent=option[1];if(option[0]===previous)node.selected=true;select.appendChild(node);}};
const isInstrumentDriverOnly=()=>val('runtimeSupport')==='Instrument Driver Support Only';const updateForcedModuleControls=()=>{const unavailable=isInstrumentDriverOnly();const enabled=!unavailable&&flag('usingLoadExternalModule');const zone=el('loadExternalModuleSection');if(zone){zone.classList.toggle('disabled-zone',unavailable);zone.setAttribute('aria-disabled',String(unavailable));}if(el('usingLoadExternalModule'))el('usingLoadExternalModule').disabled=unavailable;for(const id of ['addForcedModules','addForcedModuleName'])if(el(id))el(id).disabled=!enabled;for(const button of document.querySelectorAll('.module-remove'))button.disabled=!enabled;const targetLabel=val('targetType')==='Dynamic Link Library'?'DLL':'executable';if(el('addForcedModules'))el('addForcedModules').textContent='Add files to '+targetLabel+'…';};
const disableField=(id,disabled)=>{const node=el(id);if(node)node.disabled=disabled;};const disableBrowse=(field,disabled)=>{const button=document.querySelector('[data-browse-field="'+field+'"]');if(button)button.disabled=disabled;};const toggleDisabledZone=(id,disabled)=>{const zone=el(id);if(zone){zone.classList.toggle('disabled-control-zone',disabled);zone.setAttribute('aria-disabled',String(disabled));}};let dllProgramName=${safeScriptJson(settings.run.externalProcessPath)};const updateImportLibraryChoicesSummary=()=>{const values=[];if(flag('useIviSubdirectoriesForImportLibraries'))values.push('IVI');if(flag('useVxiPnpSubdirectoriesForImportLibraries'))values.push('VXIplug&play');if(el('importLibraryChoicesSummary'))el('importLibraryChoicesSummary').textContent=values.length?values.join(' · '):'No import-library subdirectory';};const updateTargetCreationControls=()=>{const manifestEnabled=flag('manifestEmbed');disableField('manifestPath',!manifestEnabled);disableBrowse('manifestPath',!manifestEnabled);toggleDisabledZone('manifestPathRow',!manifestEnabled);};const updateDllOptionControls=()=>{const useDefault=flag('useDefaultImportLibBaseName');disableField('importLibBaseName',useDefault);toggleDisabledZone('importLibBaseNameRow',useDefault);const customDirectory=val('whereToCopyDll')==='Custom directory';disableField('customDirectoryToCopyDll',!customDirectory);disableBrowse('customDirectoryToCopyDll',!customDirectory);toggleDisabledZone('customDirectoryToCopyDllRow',!customDirectory);const headersEnabled=val('dllExports')!=='Symbols Marked As Export';const block=el('dllExportHeadersBlock');if(block){block.classList.toggle('disabled-sub-block',!headersEnabled);block.setAttribute('aria-disabled',String(!headersEnabled));}for(const input of document.querySelectorAll('[data-export-file]'))input.disabled=!headersEnabled;updateImportLibraryChoicesSummary();};let importChoicesSnapshot={ivi:false,vxi:false};const showImportLibraryChoices=()=>{importChoicesSnapshot={ivi:flag('useIviSubdirectoriesForImportLibraries'),vxi:flag('useVxiPnpSubdirectoriesForImportLibraries')};el('importLibraryChoicesDialog')?.classList.remove('hidden');};const hideImportLibraryChoices=(restore)=>{if(restore){if(el('useIviSubdirectoriesForImportLibraries'))el('useIviSubdirectoriesForImportLibraries').checked=importChoicesSnapshot.ivi;if(el('useVxiPnpSubdirectoriesForImportLibraries'))el('useVxiPnpSubdirectoriesForImportLibraries').checked=importChoicesSnapshot.vxi;}el('importLibraryChoicesDialog')?.classList.add('hidden');updateImportLibraryChoicesSummary();};const updateDllTypeInformationControls=()=>{const typeLibEnabled=flag('addTypeLibToDll');const helpLinksEnabled=typeLibEnabled&&flag('includeTypeLibHelpLinks');const typeBlock=el('typeLibraryResourceBlock');if(typeBlock){typeBlock.classList.toggle('disabled-sub-block',!typeLibEnabled);typeBlock.setAttribute('aria-disabled',String(!typeLibEnabled));}disableField('includeTypeLibHelpLinks',!typeLibEnabled);disableField('tlbHelpStyle',!helpLinksEnabled);disableField('typeLibFpFile',!typeLibEnabled);disableBrowse('typeLibFpFile',!typeLibEnabled);const niEnabled=flag('addNiTypeInfoToDll');const singleHeader=niEnabled&&flag('niTypeInfoFromSingleHeader');const niBlock=el('niTypeInfoResourceBlock');if(niBlock){niBlock.classList.toggle('disabled-sub-block',!niEnabled);niBlock.setAttribute('aria-disabled',String(!niEnabled));}disableField('niTypeInfoFromAllSources',!niEnabled);disableField('niTypeInfoFromSingleHeader',!niEnabled);const headerRow=el('singleHeaderNiTypeInfoRow');if(headerRow)headerRow.classList.toggle('hidden',!singleHeader);disableField('singleHeaderNiTypeInfoFile',!singleHeader);disableBrowse('singleHeaderNiTypeInfoFile',!singleHeader);};const updateSigningControls=()=>{const enabled=flag('signEnabled');toggleDisabledZone('signingDetailsBlock',!enabled);for(const id of ['signDebugBuild','signStore','signCertificate','signTimestampUrl','signDescriptionUrl'])disableField(id,!enabled);};const updateExecutableCommandLineControls=()=>{const dll=val('targetType')==='Dynamic Link Library';const program=el('externalProcessPath');if(program){if(dll){program.value=dllProgramName;}else{program.value=val('outputPath');}}disableField('externalProcessPath',!dll);disableBrowse('externalProcessPath',!dll);toggleDisabledZone('externalProcessPathRow',!dll);};
const renderForcedModules=()=>{forcedModules=[...new Set(forcedModules.map(v=>String(v).trim()).filter(Boolean))];if(el('forcedModules'))el('forcedModules').value=forcedModules.join(String.fromCharCode(10));const host=el('forcedModulesPreview');if(!host)return;host.innerHTML='';if(!forcedModules.length){const empty=document.createElement('div');empty.className='empty-modules';empty.textContent='No module is currently included.';host.appendChild(empty);updateForcedModuleControls();return;}forcedModules.forEach((value,index)=>{const row=document.createElement('div');row.className='module-row';const label=document.createElement('span');label.textContent=value;label.title=value;const remove=document.createElement('button');remove.type='button';remove.className='module-remove';remove.textContent='Remove';remove.addEventListener('click',()=>{forcedModules.splice(index,1);renderForcedModules();markDirty();});row.append(label,remove);host.appendChild(row);});updateForcedModuleControls();};
const updateTargetControls=()=>{document.body.dataset.target=val('targetType');replaceOptions('runtimeBinding',bindingOptions[val('targetType')]||[]);updateForcedModuleControls();updateTargetCreationControls();updateDllOptionControls();updateDllTypeInformationControls();updateSigningControls();updateExecutableCommandLineControls();applyFilter();};
document.querySelectorAll('[data-browse-field]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:'browse',field:button.dataset.browseField})));el('dllAnalyzerBrowse')?.addEventListener('click',()=>vscode.postMessage({type:'browseDllAnalyzer'}));el('dllAnalyzerRun')?.addEventListener('click',()=>vscode.postMessage({type:'analyzeDll',path:val('dllAnalyzerPath')}));el('dllAnalyzerExport')?.addEventListener('click',()=>vscode.postMessage({type:'exportDllAnalysis'}));el('libraryAnalyzerBrowse')?.addEventListener('click',()=>vscode.postMessage({type:'browseLibraryAnalyzer'}));el('libraryAnalyzerRun')?.addEventListener('click',()=>vscode.postMessage({type:'analyzeLibrary',path:val('libraryAnalyzerPath')}));el('libraryAnalyzerExport')?.addEventListener('click',()=>vscode.postMessage({type:'exportLibraryAnalysis'}));const pageNavHost=el('pageNav')||document;pageNavHost.addEventListener('click',(event)=>{const target=event.target&&event.target.closest?event.target.closest('[data-settings-page-target]'):null;if(!target)return;const page=target.dataset.settingsPageTarget;if(!page)return;event.preventDefault();event.stopPropagation();activatePage(page,true);});document.querySelectorAll('[data-command]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:'command',command:button.dataset.command})));sectionNav?.addEventListener('change',()=>{const id=sectionNav.value;if(id)document.getElementById(id)?.scrollIntoView({behavior:'smooth',block:'start'});sectionNav.value='';});settingsFilter?.addEventListener('input',applyFilter);document.querySelectorAll('input,select,textarea').forEach(node=>node.addEventListener('input',markDirty));
el('autocompleteProfile')?.addEventListener('change',()=>{updateAutocompleteControls();markDirty();});['autocompleteCompletionEnabled','autocompleteProjectSymbols','autocompleteCviApi','autocompleteSignatureHelp'].forEach(id=>el(id)?.addEventListener('change',()=>{updateAutocompleteControls();markDirty();}));el('resetAutocompleteHybrid')?.addEventListener('click',()=>{if(el('autocompleteProfile'))el('autocompleteProfile').value='hybrid';updateAutocompleteControls();markDirty();});
el('targetType')?.addEventListener('change',()=>{if(document.body.dataset.target==='Dynamic Link Library')dllProgramName=val('externalProcessPath');updateTargetControls();});el('outputPath')?.addEventListener('input',updateExecutableCommandLineControls);el('externalProcessPath')?.addEventListener('input',()=>{if(val('targetType')==='Dynamic Link Library')dllProgramName=val('externalProcessPath');});el('configurationScope')?.addEventListener('change',()=>vscode.postMessage({type:'changeScope',scope:val('configurationScope')}));el('runtimeSupport')?.addEventListener('change',updateForcedModuleControls);el('manifestEmbed')?.addEventListener('change',updateTargetCreationControls);el('useDefaultImportLibBaseName')?.addEventListener('change',updateDllOptionControls);el('whereToCopyDll')?.addEventListener('change',updateDllOptionControls);el('dllExports')?.addEventListener('change',updateDllOptionControls);el('openImportLibraryChoices')?.addEventListener('click',showImportLibraryChoices);el('confirmImportLibraryChoices')?.addEventListener('click',()=>hideImportLibraryChoices(false));el('cancelImportLibraryChoices')?.addEventListener('click',()=>hideImportLibraryChoices(true));el('importLibraryChoicesDialog')?.addEventListener('click',(event)=>{if(event.target===el('importLibraryChoicesDialog'))hideImportLibraryChoices(true);});el('usingLoadExternalModule')?.addEventListener('change',updateForcedModuleControls);el('addTypeLibToDll')?.addEventListener('change',updateDllTypeInformationControls);el('includeTypeLibHelpLinks')?.addEventListener('change',updateDllTypeInformationControls);el('addNiTypeInfoToDll')?.addEventListener('change',updateDllTypeInformationControls);el('niTypeInfoFromAllSources')?.addEventListener('change',updateDllTypeInformationControls);el('niTypeInfoFromSingleHeader')?.addEventListener('change',updateDllTypeInformationControls);el('signEnabled')?.addEventListener('change',updateSigningControls);el('addForcedModules')?.addEventListener('click',()=>vscode.postMessage({type:'browseForcedModules'}));el('addForcedModuleName')?.addEventListener('click',()=>vscode.postMessage({type:'promptForcedModuleName'}));
window.addEventListener('message',(event)=>{const message=event.data;if(message?.type==='setField'&&el(message.field)){el(message.field).value=message.value||'';markDirty();}if(message?.type==='appendForcedModules'&&Array.isArray(message.values)){forcedModules.push(...message.values);renderForcedModules();markDirty();}});
const collectBuildParameters=()=>({type:'save',scope:val('configurationScope'),targetType:val('targetType'),buildLogDetail:val('buildLogDetail'),autocomplete:{profile:val('autocompleteProfile'),completionEnabled:flag('autocompleteCompletionEnabled'),includeProjectCompletion:flag('autocompleteProjectSymbols'),includeCviApiCompletion:flag('autocompleteCviApi'),signatureHelpEnabled:flag('autocompleteSignatureHelp')},settings:{preBuildActions:lines('preBuildActions'),customBuildActions:lines('customBuildActions'),postBuildActions:lines('postBuildActions'),dependencies:[...document.querySelectorAll('[data-dependency]:checked')].map(e=>e.dataset.dependency),run:{arguments:val('arguments'),workingDirectory:val('workingDirectory'),environmentOptions:val('environmentOptions'),externalProcessPath:val('targetType')==='Dynamic Link Library'?val('externalProcessPath'):''},externalBuild:{engine:val('externalBuildEngine'),vcvarsallPath:val('externalVcvarsallPath'),buildDirectory:val('externalBuildDirectory'),additionalCompilerOptions:val('externalCompilerOptions'),additionalLinkerOptions:val('externalLinkerOptions'),additionalLibraries:lines('externalLibraries'),useCviExternalSupportFiles:flag('externalUseCviSupport'),debugInVsCode:flag('externalDebugVsCode'),dllImportLibraryFormat:val('externalDllImportLibraryFormat')||'auto'},importLibraries:{generator:val('importLibraryGenerator')||'auto',generatorPath:val('importLibraryGeneratorPath'),architecture:val('importLibraryArchitecture')||'auto',outputDirectory:val('importLibraryOutputDirectory')||'lib',keepDefinitionFile:flag('importLibraryKeepDefinitionFile')}},nativeTarget:{targetType:val('targetType'),outputPath:val('outputPath'),applicationTitle:val('applicationTitle'),iconFile:val('iconFile'),runtimeSupport:val('runtimeSupport'),runtimeBinding:val('runtimeBinding'),generateSourceDocumentation:val('generateSourceDocumentation'),manifestEmbed:flag('manifestEmbed'),manifestPath:val('manifestPath'),embedProjectUirs:flag('embedProjectUirs'),generateMapFile:flag('generateMapFile'),createConsoleApplication:flag('createConsoleApplication'),embedTimestamp:flag('embedTimestamp'),usingLoadExternalModule:flag('usingLoadExternalModule'),forcedModules:lines('forcedModules'),useDefaultImportLibBaseName:flag('useDefaultImportLibBaseName'),dllImportLibraryChoice:val('dllImportLibraryChoice'),importLibBaseName:val('importLibBaseName'),whereToCopyDll:val('whereToCopyDll'),customDirectoryToCopyDll:val('customDirectoryToCopyDll'),useIviSubdirectoriesForImportLibraries:flag('useIviSubdirectoriesForImportLibraries'),useVxiPnpSubdirectoriesForImportLibraries:flag('useVxiPnpSubdirectoriesForImportLibraries'),dllExports:val('dllExports'),exportFiles:chosen('[data-export-file]'),addTypeLibToDll:flag('addTypeLibToDll'),includeTypeLibHelpLinks:flag('includeTypeLibHelpLinks'),tlbHelpStyle:val('tlbHelpStyle'),typeLibFpFile:val('typeLibFpFile'),addNiTypeInfoToDll:flag('addNiTypeInfoToDll'),useSingleHeaderForNiTypeInfo:flag('niTypeInfoFromSingleHeader'),singleHeaderNiTypeInfoFile:val('singleHeaderNiTypeInfoFile'),versionInfo:{numericFileVersion:val('numericFileVersion'),numericProductVersion:val('numericProductVersion'),comments:val('versionComments'),companyName:val('companyName'),fileDescription:val('fileDescription'),fileVersion:val('fileVersion'),internalName:val('internalName'),legalCopyright:val('legalCopyright'),legalTrademarks:val('legalTrademarks'),originalFilename:val('originalFilename'),privateBuild:val('privateBuild'),productName:val('productName'),productVersion:val('productVersion'),specialBuild:val('specialBuild')},signing:{enabled:flag('signEnabled'),store:val('signStore'),certificate:val('signCertificate'),timestampUrl:val('signTimestampUrl'),descriptionUrl:val('signDescriptionUrl'),signDebugBuild:flag('signDebugBuild')}},nativeCompiler:{is64Bit:${compiler.is64Bit},isRelease:${compiler.isRelease},defaultCallingConvention:val('defaultCallingConvention'),optimizationLevel:val('optimizationLevel'),supportsOptimizationLevel:${compiler.supportsOptimizationLevel},requirePrototypes:flag('requirePrototypes'),showWarningIdsInBuildOutput:flag('showWarningIdsInBuildOutput'),supportsWarningProfile:${compiler.supportsWarningProfile},selectedWarningLevel:val('selectedWarningLevel'),warningListNone:${safeScriptJson(compiler.warningListNone)},warningListCommon:${safeScriptJson(compiler.warningListCommon)},warningListExtended:${safeScriptJson(compiler.warningListExtended)},warningListAll:${safeScriptJson(compiler.warningListAll)},warningMode:val('warningMode'),enablePointerMismatchWarning:flag('enablePointerMismatchWarning'),enableUnreachableCodeWarning:flag('enableUnreachableCodeWarning'),enableUnreferencedIdentifiersWarning:flag('enableUnreferencedIdentifiersWarning'),enableAssignmentInConditionalWarning:flag('enableAssignmentInConditionalWarning'),uninitializedLocalsCompileWarning:val('uninitializedLocalsCompileWarning'),requireReturnValues:flag('requireReturnValues'),enableC99Extensions:flag('enableC99Extensions'),enableOpenMpExtensions:flag('enableOpenMpExtensions'),supportsOpenMp:${compiler.supportsOpenMp},stackSize:val('stackSize'),stackReserve:val('stackReserve'),stackCommit:val('stackCommit'),supportsStackReserveCommit:${compiler.supportsStackReserveCommit},imageBaseAddress:val('imageBaseAddress'),imageBaseAddress64:val('imageBaseAddress64'),compilerDefines:val('compilerDefines')},projectCompiler:{includePaths:lines('includePaths'),oOptionCompatibleWith50:flag('oOptionCompatibleWith50'),precompilePrefixHeader:flag('precompilePrefixHeader'),prefixHeaderFile:val('prefixHeaderFile')},workspaceBuild:${workspaceBuild ? `{generateBrowseInfo:flag('generateBrowseInfo'),enableUninitializedLocalsRuntimeWarning:flag('enableUninitializedLocalsRuntimeWarning'),batchBuild:flag('batchBuild'),profile:val('profile'),debuggingLevel:val('debuggingLevel'),executionTrace:val('executionTrace'),breakOnLibraryErrors:flag('breakOnLibraryErrors'),breakOnFirstChanceExceptions:flag('breakOnFirstChanceExceptions')}` : 'undefined'}});
const saveNow=()=>{markSaved();vscode.postMessage(collectBuildParameters());};el('save')?.addEventListener('click',saveNow);el('saveBottom')?.addEventListener('click',saveNow);el('saveAutocomplete')?.addEventListener('click',saveNow);
renderForcedModules();updateTargetControls();updateAutocompleteControls();if(customScopeActive&&!customWorkspaceSerialized){for(const id of ['arguments','workingDirectory','environmentOptions','externalProcessPath'])disableField(id,true);disableBrowse('workingDirectory',true);disableBrowse('externalProcessPath',true);}activatePage(activePage,false);
</script></body></html>`;
  }
}

function renderDllAnalyzerHtml(filePath: string, analysis?: CviDllAnalysis): string {
  const controls = `<div class="fields"><label class="field wide">DLL file<span class="path-control"><input id="dllAnalyzerPath" value="${escapeHtml(filePath)}" placeholder="Select a Windows DLL…"><button id="dllAnalyzerBrowse" class="browse" type="button" title="Browse DLL…">Browse…</button></span></label></div><div class="actions"><button id="dllAnalyzerRun" type="button">Analyze DLL</button><button id="dllAnalyzerExport" class="secondary" type="button" ${analysis ? '' : 'disabled'}>Export report…</button></div>`;
  if (!analysis) return controls + `<div class="analysis-empty">Select a DLL to inspect its PE architecture, file/product version, exports, imports, sections, resources, certificate presence and PDB metadata.</div>`;
  const meta: Array<[string,string]> = [
    ['File', analysis.fileName], ['Architecture', `${analysis.architecture} · ${analysis.machineLabel}`], ['PE format', analysis.peFormat],
    ['File version', analysis.version.fileVersion ?? 'Not available'], ['Product version', analysis.version.productVersion ?? 'Not available'], ['Revision', analysis.version.fileVersion?.split('.')[3] ?? 'Not available'],
    ['Link timestamp', analysis.timestampIso ?? 'Not set'], ['Image base', analysis.imageBase], ['Entry point', `RVA 0x${analysis.entryPointRva.toString(16).toUpperCase()}`],
    ['Subsystem', analysis.subsystemLabel], ['File size', `${analysis.fileSize} bytes`], ['SHA-256', analysis.sha256],
    ['Authenticode', analysis.authenticodePresent ? `Certificate table present (${analysis.authenticodeSize} bytes)` : 'No certificate table'], ['.NET / CLR', analysis.dotNet ? 'CLR header present' : 'Native PE / no CLR header']
  ];
  const metaHtml = `<div class="analysis-grid">${meta.map(([k,v])=>`<div class="analysis-kv"><strong>${escapeHtml(k)}</strong><span>${escapeHtml(v)}</span></div>`).join('')}</div>`;
  const versionHtml = Object.keys(analysis.version.strings).length ? `<h3>Version strings</h3><div class="analysis-grid">${Object.entries(analysis.version.strings).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`<div class="analysis-kv"><strong>${escapeHtml(k)}</strong><span>${escapeHtml(v)}</span></div>`).join('')}</div>` : '';
  const exportRows = analysis.exports.map(x=>`<tr><td>${x.ordinal}</td><td><code>${escapeHtml(x.name)}</code></td><td>0x${x.rva.toString(16).toUpperCase()}</td><td>${escapeHtml(x.forwarder ?? '')}</td></tr>`).join('') || '<tr><td colspan="4">No named exports.</td></tr>';
  const exportsHtml = `<h3>Exports (${analysis.exports.length}${analysis.ordinalOnlyExportCount ? ` + ${analysis.ordinalOnlyExportCount} ordinal-only` : ''})</h3><div class="analysis-scroll"><table class="analysis-table"><thead><tr><th>Ordinal</th><th>Name / function</th><th>RVA</th><th>Forwarder</th></tr></thead><tbody>${exportRows}</tbody></table></div>`;
  const importRows = analysis.imports.flatMap(m=>m.symbols.length?m.symbols.map(x=>`<tr><td><code>${escapeHtml(m.dll)}</code></td><td>${x.name?`<code>${escapeHtml(x.name)}</code>`:`ordinal ${x.ordinal ?? ''}`}</td><td>${x.hint ?? ''}</td></tr>`):[`<tr><td><code>${escapeHtml(m.dll)}</code></td><td colspan="2">No decoded symbols</td></tr>`]).join('') || '<tr><td colspan="3">No imports.</td></tr>';
  const importsHtml = `<h3>Imports / dependencies (${analysis.imports.length} DLLs)</h3><div class="analysis-scroll"><table class="analysis-table"><thead><tr><th>DLL</th><th>Symbol</th><th>Hint</th></tr></thead><tbody>${importRows}</tbody></table></div>`;
  const sectionsHtml = `<h3>Sections</h3><div class="analysis-scroll"><table class="analysis-table"><thead><tr><th>Name</th><th>RVA</th><th>Virtual size</th><th>Raw size</th><th>Characteristics</th></tr></thead><tbody>${analysis.sections.map(x=>`<tr><td><code>${escapeHtml(x.name)}</code></td><td>0x${x.virtualAddress.toString(16).toUpperCase()}</td><td>${x.virtualSize}</td><td>${x.rawSize}</td><td>0x${x.characteristics.toString(16).toUpperCase()}</td></tr>`).join('')}</tbody></table></div>`;
  const resourcesHtml = `<h3>Resources</h3><div class="analysis-badges">${analysis.resources.length?analysis.resources.map(x=>`<span class="analysis-badge">${escapeHtml(x.name ?? `type ${x.id ?? '?'}`)}${x.id!==undefined?` (${x.id})`:''}: ${x.count}</span>`).join(''):'<span class="muted">No resources.</span>'}</div>`;
  const flagsHtml = `<h3>PE flags</h3><div class="analysis-badges">${[...analysis.fileCharacteristics,...analysis.dllCharacteristics].map(x=>`<span class="analysis-badge">${escapeHtml(x)}</span>`).join('') || '<span class="muted">No decoded flags.</span>'}</div>`;
  const debugHtml = analysis.debug.pdbPath || analysis.debug.pdbGuid ? `<h3>Debug / PDB</h3><div class="analysis-grid">${analysis.debug.pdbPath?`<div class="analysis-kv"><strong>PDB path</strong><span>${escapeHtml(analysis.debug.pdbPath)}</span></div>`:''}${analysis.debug.pdbGuid?`<div class="analysis-kv"><strong>PDB GUID</strong><span>${escapeHtml(analysis.debug.pdbGuid)}</span></div>`:''}${analysis.debug.pdbAge!==undefined?`<div class="analysis-kv"><strong>PDB age</strong><span>${analysis.debug.pdbAge}</span></div>`:''}</div>` : '';
  return controls + metaHtml + versionHtml + exportsHtml + importsHtml + sectionsHtml + resourcesHtml + flagsHtml + debugHtml;
}

function renderLibraryAnalyzerHtml(filePath: string, analysis?: CviLibraryAnalysis): string {
  const controls = `<div class="fields"><label class="field wide">Library file<span class="path-control"><input id="libraryAnalyzerPath" value="${escapeHtml(filePath)}" placeholder="Select a .a or .lib archive…"><button id="libraryAnalyzerBrowse" class="browse" type="button" title="Browse .a/.lib…">Browse…</button></span></label></div><div class="actions"><button id="libraryAnalyzerRun" type="button">Analyze library</button><button id="libraryAnalyzerExport" class="secondary" type="button" ${analysis ? '' : 'disabled'}>Export report…</button></div>`;
  if (!analysis) return controls + `<div class="analysis-empty">Select a GNU <code>.a</code>, MinGW <code>.dll.a</code> or Windows/LLVM <code>.lib</code> archive to inspect members, target architectures, linker symbols and import-library metadata.</div>`;
  const meta: Array<[string,string]> = [
    ['File', analysis.fileName], ['Extension', analysis.extension], ['Classification', `${analysis.libraryKind} library`], ['Archive format', analysis.archiveFormat],
    ['Architectures', analysis.architectures.length ? analysis.architectures.join(', ') : 'Not detected'], ['Members', String(analysis.memberCount)], ['Object members', String(analysis.objectMemberCount)],
    ['Import-object members', String(analysis.importObjectCount)], ['Linker symbols', String(analysis.linkerSymbolCount)], ['File size', `${analysis.fileSize} bytes`], ['Modified', analysis.modifiedIso], ['SHA-256', analysis.sha256]
  ];
  const metaHtml = `<div class="analysis-grid">${meta.map(([k,v])=>`<div class="analysis-kv"><strong>${escapeHtml(k)}</strong><span>${escapeHtml(v)}</span></div>`).join('')}</div>`;
  const dllHtml = `<h3>Referenced runtime DLLs</h3><div class="analysis-badges">${analysis.importDlls.length ? analysis.importDlls.map(x=>`<span class="analysis-badge">${escapeHtml(x)}</span>`).join('') : '<span class="muted">No DLL reference detected.</span>'}</div>`;
  const symbolRows = analysis.symbols.map((x,i)=>`<tr><td>${i+1}</td><td><code>${escapeHtml(x)}</code></td></tr>`).join('') || '<tr><td colspan="2">No archive linker symbols decoded.</td></tr>';
  const symbolsHtml = `<h3>Linker symbols (${analysis.symbols.length})</h3><div class="analysis-scroll"><table class="analysis-table"><thead><tr><th>#</th><th>Symbol</th></tr></thead><tbody>${symbolRows}</tbody></table></div>`;
  const memberRows = analysis.members.map(x=>`<tr><td><code>${escapeHtml(x.name)}</code></td><td>${escapeHtml(x.kind)}</td><td>${escapeHtml(x.architecture ?? '')}</td><td>${x.size}</td><td>${x.importDll ? `<code>${escapeHtml(x.importDll)}</code>` : ''}</td><td>${x.importSymbol ? `<code>${escapeHtml(x.importSymbol)}</code>` : ''}</td><td>${x.symbols.length}</td></tr>`).join('') || '<tr><td colspan="7">No archive members decoded.</td></tr>';
  const membersHtml = `<h3>Archive members</h3><div class="analysis-scroll"><table class="analysis-table"><thead><tr><th>Name</th><th>Kind</th><th>Architecture</th><th>Size</th><th>Import DLL</th><th>Import symbol</th><th>Symbols</th></tr></thead><tbody>${memberRows}</tbody></table></div>`;
  const notesHtml = `<h3>Notes</h3><ul>${analysis.notes.map(note=>`<li>${escapeHtml(note)}</li>`).join('')}</ul>`;
  return controls + metaHtml + dllHtml + symbolsHtml + membersHtml + notesHtml;
}


type SelectOption = readonly [value: string, label: string];

function targetOption(value: string, selected?: string): string { return `<option value="${escapeHtml(value)}" ${value === selected ? 'selected' : ''}>${escapeHtml(value)}</option>`; }
function checked(value: boolean): string { return value ? 'checked' : ''; }
function textField(label: string, id: string, value: string, placeholder = ''): string { return `<label class="field">${escapeHtml(label)}<input id="${escapeHtml(id)}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}"></label>`; }
function pathField(label: string, id: string, value: string): string { return `<label class="field">${escapeHtml(label)}<span class="path-control"><input id="${escapeHtml(id)}" value="${escapeHtml(value)}"><button class="browse" type="button" data-browse-field="${escapeHtml(id)}" title="Browse…" aria-label="Browse ${escapeHtml(label)}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 3.25A1.25 1.25 0 0 1 2.75 2h3.1c.4 0 .77.19 1 .5l.6.8h5.8a1.25 1.25 0 0 1 1.25 1.25v6.7a1.25 1.25 0 0 1-1.25 1.25H2.75a1.25 1.25 0 0 1-1.25-1.25v-8Zm1.25-.1a.1.1 0 0 0-.1.1v1h10.7v-.7a.1.1 0 0 0-.1-.1H6.88l-.95-1.27a.1.1 0 0 0-.08-.03h-3.1Zm-.1 2.25v5.85c0 .06.04.1.1.1h10.5a.1.1 0 0 0 .1-.1V5.4H2.65Z"/></svg></button></span></label>`; }
function selectField(label: string, id: string, selected: string, options: SelectOption[]): string { return `<label class="field">${escapeHtml(label)}<select id="${escapeHtml(id)}">${selectOptions(options, selected)}</select></label>`; }
function selectOptions(options: SelectOption[], selected: string): string { const values = [...options]; if (selected && !values.some(([value]) => value === selected)) { values.push([selected, `${selected} (existing value)`]); } return values.map(([value, label]) => `<option value="${escapeHtml(value)}" ${value === selected ? 'selected' : ''}>${escapeHtml(label)}</option>`).join(''); }
function splitSafeList(value: string): string[] { return value.split(/(?:\r?\n|;)/).map((entry) => entry.trim()).filter(Boolean); }
function escapeHtml(value: string): string { return String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'); }
function stripCodicon(value: string): string { return value.replace(/^\$\([^)]*\)\s*/, ''); }
function normalizeBuildLogDetail(value: string | undefined): 'compact' | 'normal' | 'verbose' { return value === 'compact' || value === 'verbose' ? value : 'normal'; }
function safeScriptJson(value: unknown): string { return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026'); }
function customScopeName(scope: BuildSettingsScope): string | undefined {
  if (!String(scope).startsWith('custom:')) return undefined;
  try { return decodeURIComponent(String(scope).slice('custom:'.length)); } catch { return String(scope).slice('custom:'.length); }
}
function customScope(name: string): BuildSettingsScope { return `custom:${encodeURIComponent(name)}`; }
function scopeModes(scope: BuildSettingsScope): CviBuildMode[] { return scope === 'all' ? [...ALL_BUILD_MODES] : customScopeName(scope) ? [] : [scope as CviBuildMode]; }
function scopeLabel(scope: BuildSettingsScope): string { const custom = customScopeName(scope); if (custom) return custom; return ({ debug: 'Debug', release: 'Release', debug64: 'Debug64', release64: 'Release64', all: 'All Configurations' } as const)[scope as CviBuildMode | 'all']; }
function scopeOptions(selected: BuildSettingsScope, customNames: string[] = []): string { return scopeChoices(customNames).map((entry) => `<option value="${entry.id}" ${entry.id === selected ? 'selected' : ''}>${escapeHtml(entry.label)}</option>`).join(''); }
function scopeChoices(customNames: string[] = []): Array<{ id: BuildSettingsScope; label: string; description?: string }> { return [
  { id: 'debug', label: 'Debug', description: '32-bit debug configuration' },
  { id: 'release', label: 'Release', description: '32-bit release configuration' },
  { id: 'debug64', label: 'Debug64', description: '64-bit debug configuration' },
  { id: 'release64', label: 'Release64', description: '64-bit release configuration' },
  ...customNames.map((name) => ({ id: customScope(name), label: name, description: 'Native custom CVI configuration' })),
  { id: 'all', label: 'All Standard Configurations', description: 'Apply entered values to Debug, Release, Debug64 and Release64' }
]; }
function parseScope(value: unknown, fallback: BuildSettingsScope): BuildSettingsScope { if (value === 'debug' || value === 'release' || value === 'debug64' || value === 'release64' || value === 'all') return value; if (typeof value === 'string' && value.startsWith('custom:')) return value as BuildSettingsScope; return fallback; }
async function pickStoredValue(title: string, options: SelectOption[], selected: string): Promise<string | undefined> { const list = [...options]; if (selected && !list.some(([value]) => value === selected)) { list.push([selected, `${selected} (existing value)`]); } const picked = await vscode.window.showQuickPick(list.map(([value, label]) => ({ value, label, description: value === label ? undefined : value })), { title }); return picked?.value; }
function normalizeAutocompleteProfile(value: unknown): CviAutocompleteProfile { return value === 'native' || value === 'nativeSignature' || value === 'cviApi' || value === 'custom' ? value : 'hybrid'; }
function autocompleteProfileLabel(profile: CviAutocompleteProfile): string { return ({ hybrid: 'Hybrid', native: 'Native', nativeSignature: 'Native + CVI Signature Help', cviApi: 'CVI API Assist', custom: 'Custom' } as const)[profile]; }
function defaultDialogUri(currentValue: string, projectDirectory: string): vscode.Uri { if (!currentValue) { return vscode.Uri.file(projectDirectory); } const normalizedValue = normalizeRuntimePath(currentValue); const resolved = path.isAbsolute(normalizedValue) || path.win32.isAbsolute(normalizedValue) ? normalizedValue : path.resolve(projectDirectory, normalizedValue); if (fs.existsSync(resolved)) { return vscode.Uri.file(resolved); } const directory = path.dirname(resolved); return vscode.Uri.file(fs.existsSync(directory) ? directory : projectDirectory); }
function browseTitle(field: string): string { return ({ outputPath: 'Select output file', iconFile: 'Select application icon file', manifestPath: 'Select manifest file', customDirectoryToCopyDll: 'Select DLL copy directory', typeLibFpFile: 'Select function-panel file', singleHeaderNiTypeInfoFile: 'Select NI type-information header', workingDirectory: 'Select working directory', externalProcessPath: 'Select Program Name executable for DLL target' } as Record<string, string>)[field] ?? 'Select file'; }
function outputFilters(targetType: string): Record<string, string[]> { if (targetType === 'Dynamic Link Library') { return { 'Dynamic-link libraries': ['dll'], 'All files': ['*'] }; } if (targetType === 'Static Library') { return { 'Static libraries': ['lib'], 'All files': ['*'] }; } return { Executables: ['exe'], 'All files': ['*'] }; }
function openFilters(field: string): Record<string, string[]> { switch (field) { case 'iconFile': return { Icons: ['ico'], 'All files': ['*'] }; case 'manifestPath': return { Manifest: ['manifest', 'xml'], 'All files': ['*'] }; case 'typeLibFpFile': return { 'Function panel files': ['fp'], 'All files': ['*'] }; case 'singleHeaderNiTypeInfoFile': return { Headers: ['h', 'hpp'], 'All files': ['*'] }; case 'externalProcessPath': return { Executables: ['exe'], 'All files': ['*'] }; default: return { 'All files': ['*'] }; } }

function portableModulePath(filePath: string, projectDirectory: string): string { const relative = path.relative(projectDirectory, filePath); if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) { return relative.replace(/\//g, '\\'); } return filePath; }
