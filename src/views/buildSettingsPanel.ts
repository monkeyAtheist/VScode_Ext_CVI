import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CviNativeTargetSettings, CviParser } from '../model/cviParser';
import { CviBuildMode, CviWorkspaceProjectRef } from '../model/types';
import { CviProjectBuildSettings, CviProjectSettingsService } from '../services/cviProjectSettingsService';
import { CviWorkspaceService } from '../services/cviWorkspaceService';
import { normalizeRuntimePath } from '../utils/pathUtils';

type BuildSettingsScope = CviBuildMode | 'all';

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

export class BuildSettingsPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private projectRef?: CviWorkspaceProjectRef;
  private selectedScope: BuildSettingsScope = 'debug';

  constructor(
    private readonly workspaces: CviWorkspaceService,
    private readonly parser: CviParser,
    private readonly settings: CviProjectSettingsService
  ) {}

  show(projectRef?: CviWorkspaceProjectRef): void {
    const ref = projectRef ?? this.workspaces.activeProjectRef;
    if (!ref?.exists) {
      vscode.window.showErrorMessage('No existing CVI project is selected.');
      return;
    }
    this.projectRef = ref;
    if (!this.panel) {
      this.selectedScope = this.buildMode;
      this.panel = vscode.window.createWebviewPanel('labwindowsCvi.buildSettings', 'CVI Project Build Settings', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
      this.panel.onDidDispose(() => { this.panel = undefined; this.projectRef = undefined; });
      this.panel.webview.onDidReceiveMessage((message) => void this.handleMessage(message));
    }
    this.panel.title = `CVI Build Settings — ${ref.name}`;
    this.panel.webview.html = this.render(ref);
    this.panel.reveal(vscode.ViewColumn.Active);
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
    let scope = this.selectedScope;

    while (true) {
      const representativeMode = this.representativeMode(scope);
      const target = this.parser.getNativeTargetSettings(ref.absolutePath, representativeMode);
      const projectSettings = this.settings.getSettings(ref, representativeMode);
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
        { id: 'externalProcessPath', label: '$(debug-start) External executable for DLL debugging', description: projectSettings.run.externalProcessPath || 'Empty' },
        { id: 'preBuildActions', label: '$(list-ordered) Pre-build actions', description: `${projectSettings.preBuildActions.length} action(s)` },
        { id: 'customBuildActions', label: '$(list-ordered) Custom build actions', description: `${projectSettings.customBuildActions.length} action(s)` },
        { id: 'postBuildActions', label: '$(list-ordered) Post-build actions', description: `${projectSettings.postBuildActions.length} action(s)` },
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
        const selected = await vscode.window.showQuickPick(scopeChoices(), { title: 'Select configuration scope' });
        if (selected) {
          scope = selected.id;
          this.selectedScope = scope;
        }
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
  }

  private async handleMessage(message: any): Promise<void> {
    if (!this.projectRef) {
      return;
    }
    if (message?.type === 'changeScope') {
      this.selectedScope = parseScope(message.scope, this.buildMode);
      this.update();
      return;
    }
    if (message?.type === 'browse') {
      await this.browseForField(String(message.field ?? ''));
      return;
    }
    if (message?.type === 'save') {
      try {
        const scope = parseScope(message.scope, this.selectedScope);
        this.selectedScope = scope;
        const settings = message.settings as CviProjectBuildSettings;
        const targetSettings = message.nativeTarget as CviNativeTargetSettings;
        if (typeof message.targetType === 'string') {
          targetSettings.targetType = message.targetType;
        }
        this.applyNativeTargetSettings(this.projectRef, scope, targetSettings);
        this.applyProjectSettings(this.projectRef, scope, settings);
        this.workspaces.refresh();
        vscode.window.showInformationMessage(`Build settings saved for ${this.projectRef.name} (${scopeLabel(scope)}).`);
        this.update();
      } catch (error) {
        vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    }
  }

  private applyNativeTargetSettings(ref: CviWorkspaceProjectRef, scope: BuildSettingsScope, target: CviNativeTargetSettings): void {
    this.parser.setTargetType(ref.absolutePath, target.targetType);
    for (const mode of scopeModes(scope)) {
      this.parser.setNativeTargetSettings(ref.absolutePath, mode, target);
    }
  }

  private applyProjectSettings(ref: CviWorkspaceProjectRef, scope: BuildSettingsScope, settings: CviProjectBuildSettings): void {
    for (const mode of scopeModes(scope)) {
      this.settings.setSettings(ref, settings, mode);
    }
  }

  private async browseForField(field: string): Promise<void> {
    const ref = this.projectRef;
    if (!ref) {
      return;
    }
    const mode = this.representativeMode(this.selectedScope);
    const target = this.parser.getNativeTargetSettings(ref.absolutePath, mode);
    const projectSettings = this.settings.getSettings(ref, mode);
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

  private get buildMode(): CviBuildMode {
    return vscode.workspace.getConfiguration('labwindowsCvi').get<CviBuildMode>('buildMode', 'debug');
  }

  private representativeMode(scope: BuildSettingsScope): CviBuildMode {
    return scope === 'all' ? this.buildMode : scope;
  }

  private render(ref: CviWorkspaceProjectRef): string {
    const representativeMode = this.representativeMode(this.selectedScope);
    const project = this.workspaces.getProject(ref);
    const settings = this.settings.getSettings(ref, representativeMode);
    const target = this.parser.getNativeTargetSettings(ref.absolutePath, representativeMode);
    const workspace = this.workspaces.currentWorkspace;
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

    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>CVI Project Build Settings</title>
<style>
*{box-sizing:border-box}body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:22px;max-width:1220px;margin:auto}h1{margin:0 0 5px;font-size:24px}h2{font-size:16px;margin:0 0 11px}h3{font-size:14px;margin:15px 0 5px}.muted{color:var(--vscode-descriptionForeground);line-height:1.45}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:12px;margin-top:16px}.card{border:1px solid var(--vscode-panel-border);border-radius:7px;background:var(--vscode-sideBar-background);padding:15px}.wide{grid-column:1/-1}label.field{display:block;margin-top:10px;font-weight:600}textarea,input,select{width:100%;margin-top:5px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);padding:7px;font:inherit;border-radius:3px}textarea{min-height:92px;resize:vertical;font-family:var(--vscode-editor-font-family)}.dependency{display:grid;grid-template-columns:auto 1fr;gap:2px 8px;padding:7px 0;border-bottom:1px solid var(--vscode-panel-border)}.dependency input,.check input{width:auto;grid-row:1/3;margin:0 6px 0 0}.dependency small{color:var(--vscode-descriptionForeground);overflow-wrap:anywhere}.check{display:block;margin:7px 0}.notice{margin-top:12px;border:1px solid var(--vscode-panel-border);background:var(--vscode-textBlockQuote-background);padding:10px;border-radius:5px;color:var(--vscode-descriptionForeground);line-height:1.45}.actions{display:flex;justify-content:flex-end;margin-top:16px}button{border:1px solid var(--vscode-button-border,transparent);background:var(--vscode-button-background);color:var(--vscode-button-foreground);padding:8px 14px;border-radius:3px;cursor:pointer}.path{font-family:var(--vscode-editor-font-family);font-size:12px;overflow-wrap:anywhere;margin-top:5px;color:var(--vscode-descriptionForeground)}details{margin-top:16px}summary{cursor:pointer;font-weight:700}.target-dll,.target-exe,.target-nonlib{display:none}body[data-target="Dynamic Link Library"] .target-dll{display:block}body[data-target="Executable"] .target-exe{display:block}body:not([data-target="Static Library"]) .target-nonlib{display:block}.two{display:grid;grid-template-columns:1fr 1fr;gap:10px}.inline{display:flex;gap:14px;flex-wrap:wrap;margin-top:10px}.inline .check{margin:0}.warning{color:var(--vscode-editorWarning-foreground)}.path-control{display:grid;grid-template-columns:minmax(0,1fr) 34px;gap:5px;align-items:end}.path-control input{min-width:0}.browse{display:flex;align-items:center;justify-content:center;margin-top:5px;padding:6px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border-color:var(--vscode-button-border,transparent)}.browse:hover{background:var(--vscode-button-secondaryHoverBackground)}.browse svg{width:16px;height:16px;fill:currentColor}.scope{margin-top:12px;max-width:420px}.scope-note{margin-top:7px;color:var(--vscode-descriptionForeground)}@media(max-width:760px){.two{grid-template-columns:1fr}}
</style></head>
<body data-target="${escapeHtml(target.targetType)}">
<h1>CVI Project Build Settings</h1><div class="muted">${escapeHtml(ref.name)} · edited configuration: <strong>${escapeHtml(scopeLabel(mode))}</strong></div><div class="path">${escapeHtml(ref.absolutePath)}</div>
<label class="field scope">Configuration scope<select id="configurationScope">${scopeOptions(mode)}</select></label><div class="scope-note">${mode === 'all' ? 'The entered values will be applied to Debug, Release, Debug64 and Release64.' : `Only ${escapeHtml(scopeLabel(mode))} will be modified.`}</div>
<div class="notice">Native target settings are read from and written to the selected CVI <code>.prj</code> configuration. A timestamped backup is created before every native write. Project dependencies remain mirrored in <code>.vscode/labwindows-cvi-build.json</code> until a non-empty CVI dependency reference sample is available.</div>
<div class="grid">
<section class="card"><h2>Target</h2><label class="field">Target type<select id="targetType">${targetOption('Executable', target.targetType)}${targetOption('Dynamic Link Library', target.targetType)}${targetOption('Static Library', target.targetType)}</select></label>${pathField('Output file', 'outputPath', target.outputPath)}<p class="muted">The output path applies to ${escapeHtml(scopeLabel(mode))}.</p></section>
<section class="card"><h2>Project dependencies and build order</h2><p class="muted">Checked projects are built before ${escapeHtml(ref.name)}.</p>${dependencies}</section>
<section class="card wide target-nonlib"><h2>Target creation options</h2><div class="two"><label class="field target-exe">Application title<input id="applicationTitle" value="${escapeHtml(target.applicationTitle)}"></label><div class="target-exe">${pathField('Application icon file', 'iconFile', target.iconFile)}</div>${selectField('Run-time support', 'runtimeSupport', target.runtimeSupport, RUNTIME_SUPPORT_OPTIONS)}${selectField('Run-time engine binding', 'runtimeBinding', target.runtimeBinding, runtimeBindingOptions)}${selectField('Generate help from source', 'generateSourceDocumentation', target.generateSourceDocumentation, SOURCE_DOCUMENTATION_OPTIONS)}${pathField('Manifest file', 'manifestPath', target.manifestPath)}</div><div class="inline"><label class="check"><input id="manifestEmbed" type="checkbox" ${checked(target.manifestEmbed)}> Embed manifest</label><label class="check"><input id="embedProjectUirs" type="checkbox" ${checked(target.embedProjectUirs)}> Embed project .UIRs</label><label class="check"><input id="generateMapFile" type="checkbox" ${checked(target.generateMapFile)}> Generate map file</label><label class="check target-exe"><input id="createConsoleApplication" type="checkbox" ${checked(target.createConsoleApplication)}> Create console application</label><label class="check"><input id="embedTimestamp" type="checkbox" ${checked(target.embedTimestamp)}> Embed timestamp</label></div></section>
<section class="card wide target-nonlib"><h2>LoadExternalModule options</h2><p class="muted warning">Compatibility option retained by CVI. Add one .lib or .obj module per line.</p><label class="check"><input id="usingLoadExternalModule" type="checkbox" ${checked(target.usingLoadExternalModule)}> Enable LoadExternalModule</label><textarea id="forcedModules">${escapeHtml(target.forcedModules.join('\n'))}</textarea></section>
<section class="card wide target-dll"><h2>DLL options</h2><div class="two"><label class="field">Import library base name<input id="importLibBaseName" value="${escapeHtml(target.importLibBaseName)}"></label>${selectField('Where to copy DLL', 'whereToCopyDll', target.whereToCopyDll, DLL_COPY_OPTIONS)}${pathField('Custom copy directory', 'customDirectoryToCopyDll', target.customDirectoryToCopyDll)}${selectField('Export mode', 'dllExports', target.dllExports, DLL_EXPORT_OPTIONS)}</div><div class="inline"><label class="check"><input id="useDefaultImportLibBaseName" type="checkbox" ${checked(target.useDefaultImportLibBaseName)}> Use default import library base name</label><label class="check"><input id="useIviSubdirectoriesForImportLibraries" type="checkbox" ${checked(target.useIviSubdirectoriesForImportLibraries)}> Use IVI subdirectories</label><label class="check"><input id="useVxiPnpSubdirectoriesForImportLibraries" type="checkbox" ${checked(target.useVxiPnpSubdirectoriesForImportLibraries)}> Use VXIplug&amp;play subdirectories</label></div><h3>Headers included in DLL exports</h3>${exportFileChecks}</section>
<section class="card wide target-dll"><h2>DLL type information</h2><div class="inline"><label class="check"><input id="addTypeLibToDll" type="checkbox" ${checked(target.addTypeLibToDll)}> Add type library resource to DLL</label><label class="check"><input id="includeTypeLibHelpLinks" type="checkbox" ${checked(target.includeTypeLibHelpLinks)}> Include links to help file</label><label class="check"><input id="addNiTypeInfoToDll" type="checkbox" ${checked(target.addNiTypeInfoToDll)}> Add NI Type Information resource to DLL</label><label class="check"><input id="useSingleHeaderForNiTypeInfo" type="checkbox" ${checked(target.useSingleHeaderForNiTypeInfo)}> Data from single header file</label></div><div class="two"><label class="field">TLB help style<input id="tlbHelpStyle" value="${escapeHtml(target.tlbHelpStyle)}"></label>${pathField('Function panel file', 'typeLibFpFile', target.typeLibFpFile)}${pathField('Single NI type-info header', 'singleHeaderNiTypeInfoFile', target.singleHeaderNiTypeInfoFile)}</div></section>
<section class="card wide"><details><summary>Version information</summary><div class="two">${textField('Numeric file version', 'numericFileVersion', target.versionInfo.numericFileVersion)}${textField('Numeric product version', 'numericProductVersion', target.versionInfo.numericProductVersion)}${textField('Comments', 'versionComments', target.versionInfo.comments)}${textField('Company name', 'companyName', target.versionInfo.companyName)}${textField('File description', 'fileDescription', target.versionInfo.fileDescription)}${textField('File version', 'fileVersion', target.versionInfo.fileVersion)}${textField('Internal name', 'internalName', target.versionInfo.internalName)}${textField('Legal copyright', 'legalCopyright', target.versionInfo.legalCopyright)}${textField('Legal trademarks', 'legalTrademarks', target.versionInfo.legalTrademarks)}${textField('Original filename', 'originalFilename', target.versionInfo.originalFilename)}${textField('Private build', 'privateBuild', target.versionInfo.privateBuild)}${textField('Product name', 'productName', target.versionInfo.productName)}${textField('Product version', 'productVersion', target.versionInfo.productVersion)}${textField('Special build', 'specialBuild', target.versionInfo.specialBuild)}</div></details></section>
<section class="card wide target-nonlib"><details><summary>Signing information</summary><div class="inline"><label class="check"><input id="signEnabled" type="checkbox" ${checked(target.signing.enabled)}> Sign target</label><label class="check"><input id="signDebugBuild" type="checkbox" ${checked(target.signing.signDebugBuild)}> Sign debug build</label></div><div class="two">${textField('Certificate store', 'signStore', target.signing.store)}${textField('Certificate', 'signCertificate', target.signing.certificate)}${textField('Timestamp URL', 'signTimestampUrl', target.signing.timestampUrl)}${textField('Description URL', 'signDescriptionUrl', target.signing.descriptionUrl)}</div></details></section>
<section class="card wide"><h2>Executable command line</h2>${textField('Command line arguments','arguments',settings.run.arguments)}${pathField('Working directory','workingDirectory',settings.run.workingDirectory)}${textField('Environment options','environmentOptions',settings.run.environmentOptions,'NAME=value;OTHER=value')}${pathField('External executable for DLL debugging','externalProcessPath',settings.run.externalProcessPath)}</section>
<section class="card"><h2>Pre-build actions</h2><textarea id="preBuildActions">${escapeHtml(settings.preBuildActions.join('\n'))}</textarea></section><section class="card"><h2>Custom build actions</h2><textarea id="customBuildActions">${escapeHtml(settings.customBuildActions.join('\n'))}</textarea></section><section class="card wide"><h2>Post-build actions</h2><textarea id="postBuildActions">${escapeHtml(settings.postBuildActions.join('\n'))}</textarea></section>
</div><div class="actions"><button id="save">Save project build settings</button></div>
<script>
const vscode=acquireVsCodeApi();const el=(id)=>document.getElementById(id);const val=(id)=>el(id)?.value||'';const flag=(id)=>!!el(id)?.checked;const lines=(id)=>val(id).split(/\\r?\\n/).map(v=>v.trim()).filter(Boolean);const chosen=(selector)=>[...document.querySelectorAll(selector+':checked')].map(e=>e.value);
const bindingOptions={"Executable":${JSON.stringify(EXE_RUNTIME_BINDING_OPTIONS)},"Dynamic Link Library":${JSON.stringify(DLL_RUNTIME_BINDING_OPTIONS)},"Static Library":[]};
const replaceOptions=(id,options)=>{const select=el(id);if(!select)return;const previous=select.value;select.innerHTML='';const values=[...options];if(previous&&!values.some(v=>v[0]===previous))values.push([previous,previous+' (existing value)']);for(const option of values){const node=document.createElement('option');node.value=option[0];node.textContent=option[1];if(option[0]===previous)node.selected=true;select.appendChild(node);}};
el('targetType').addEventListener('change',()=>{document.body.dataset.target=val('targetType');replaceOptions('runtimeBinding',bindingOptions[val('targetType')]||[]);});
el('configurationScope').addEventListener('change',()=>vscode.postMessage({type:'changeScope',scope:val('configurationScope')}));
for(const button of document.querySelectorAll('[data-browse-field]'))button.addEventListener('click',()=>vscode.postMessage({type:'browse',field:button.dataset.browseField}));
window.addEventListener('message',(event)=>{const message=event.data;if(message?.type==='setField'&&el(message.field))el(message.field).value=message.value||'';});
el('save').addEventListener('click',()=>vscode.postMessage({type:'save',scope:val('configurationScope'),targetType:val('targetType'),settings:{preBuildActions:lines('preBuildActions'),customBuildActions:lines('customBuildActions'),postBuildActions:lines('postBuildActions'),dependencies:[...document.querySelectorAll('[data-dependency]:checked')].map(e=>e.dataset.dependency),run:{arguments:val('arguments'),workingDirectory:val('workingDirectory'),environmentOptions:val('environmentOptions'),externalProcessPath:val('externalProcessPath')}},nativeTarget:{targetType:val('targetType'),outputPath:val('outputPath'),applicationTitle:val('applicationTitle'),iconFile:val('iconFile'),runtimeSupport:val('runtimeSupport'),runtimeBinding:val('runtimeBinding'),generateSourceDocumentation:val('generateSourceDocumentation'),manifestEmbed:flag('manifestEmbed'),manifestPath:val('manifestPath'),embedProjectUirs:flag('embedProjectUirs'),generateMapFile:flag('generateMapFile'),createConsoleApplication:flag('createConsoleApplication'),embedTimestamp:flag('embedTimestamp'),usingLoadExternalModule:flag('usingLoadExternalModule'),forcedModules:lines('forcedModules'),useDefaultImportLibBaseName:flag('useDefaultImportLibBaseName'),importLibBaseName:val('importLibBaseName'),whereToCopyDll:val('whereToCopyDll'),customDirectoryToCopyDll:val('customDirectoryToCopyDll'),useIviSubdirectoriesForImportLibraries:flag('useIviSubdirectoriesForImportLibraries'),useVxiPnpSubdirectoriesForImportLibraries:flag('useVxiPnpSubdirectoriesForImportLibraries'),dllExports:val('dllExports'),exportFiles:chosen('[data-export-file]'),addTypeLibToDll:flag('addTypeLibToDll'),includeTypeLibHelpLinks:flag('includeTypeLibHelpLinks'),tlbHelpStyle:val('tlbHelpStyle'),typeLibFpFile:val('typeLibFpFile'),addNiTypeInfoToDll:flag('addNiTypeInfoToDll'),useSingleHeaderForNiTypeInfo:flag('useSingleHeaderForNiTypeInfo'),singleHeaderNiTypeInfoFile:val('singleHeaderNiTypeInfoFile'),versionInfo:{numericFileVersion:val('numericFileVersion'),numericProductVersion:val('numericProductVersion'),comments:val('versionComments'),companyName:val('companyName'),fileDescription:val('fileDescription'),fileVersion:val('fileVersion'),internalName:val('internalName'),legalCopyright:val('legalCopyright'),legalTrademarks:val('legalTrademarks'),originalFilename:val('originalFilename'),privateBuild:val('privateBuild'),productName:val('productName'),productVersion:val('productVersion'),specialBuild:val('specialBuild')},signing:{enabled:flag('signEnabled'),store:val('signStore'),certificate:val('signCertificate'),timestampUrl:val('signTimestampUrl'),descriptionUrl:val('signDescriptionUrl'),signDebugBuild:flag('signDebugBuild')}}}));
</script></body></html>`;
  }
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
function scopeModes(scope: BuildSettingsScope): CviBuildMode[] { return scope === 'all' ? [...ALL_BUILD_MODES] : [scope]; }
function scopeLabel(scope: BuildSettingsScope): string { return ({ debug: 'Debug', release: 'Release', debug64: 'Debug64', release64: 'Release64', all: 'All Configurations' } as const)[scope]; }
function scopeOptions(selected: BuildSettingsScope): string { return scopeChoices().map((entry) => `<option value="${entry.id}" ${entry.id === selected ? 'selected' : ''}>${escapeHtml(entry.label)}</option>`).join(''); }
function scopeChoices(): Array<{ id: BuildSettingsScope; label: string; description?: string }> { return [
  { id: 'debug', label: 'Debug', description: '32-bit debug configuration' },
  { id: 'release', label: 'Release', description: '32-bit release configuration' },
  { id: 'debug64', label: 'Debug64', description: '64-bit debug configuration' },
  { id: 'release64', label: 'Release64', description: '64-bit release configuration' },
  { id: 'all', label: 'All Configurations', description: 'Apply entered values to every build configuration' }
]; }
function parseScope(value: unknown, fallback: BuildSettingsScope): BuildSettingsScope { return value === 'debug' || value === 'release' || value === 'debug64' || value === 'release64' || value === 'all' ? value : fallback; }
async function pickStoredValue(title: string, options: SelectOption[], selected: string): Promise<string | undefined> { const list = [...options]; if (selected && !list.some(([value]) => value === selected)) { list.push([selected, `${selected} (existing value)`]); } const picked = await vscode.window.showQuickPick(list.map(([value, label]) => ({ value, label, description: value === label ? undefined : value })), { title }); return picked?.value; }
function defaultDialogUri(currentValue: string, projectDirectory: string): vscode.Uri { if (!currentValue) { return vscode.Uri.file(projectDirectory); } const normalizedValue = normalizeRuntimePath(currentValue); const resolved = path.isAbsolute(normalizedValue) || path.win32.isAbsolute(normalizedValue) ? normalizedValue : path.resolve(projectDirectory, normalizedValue); if (fs.existsSync(resolved)) { return vscode.Uri.file(resolved); } const directory = path.dirname(resolved); return vscode.Uri.file(fs.existsSync(directory) ? directory : projectDirectory); }
function browseTitle(field: string): string { return ({ outputPath: 'Select output file', iconFile: 'Select application icon file', manifestPath: 'Select manifest file', customDirectoryToCopyDll: 'Select DLL copy directory', typeLibFpFile: 'Select function-panel file', singleHeaderNiTypeInfoFile: 'Select NI type-information header', workingDirectory: 'Select working directory', externalProcessPath: 'Select external executable for DLL debugging' } as Record<string, string>)[field] ?? 'Select file'; }
function outputFilters(targetType: string): Record<string, string[]> { if (targetType === 'Dynamic Link Library') { return { 'Dynamic-link libraries': ['dll'], 'All files': ['*'] }; } if (targetType === 'Static Library') { return { 'Static libraries': ['lib'], 'All files': ['*'] }; } return { Executables: ['exe'], 'All files': ['*'] }; }
function openFilters(field: string): Record<string, string[]> { switch (field) { case 'iconFile': return { Icons: ['ico'], 'All files': ['*'] }; case 'manifestPath': return { Manifest: ['manifest', 'xml'], 'All files': ['*'] }; case 'typeLibFpFile': return { 'Function panel files': ['fp'], 'All files': ['*'] }; case 'singleHeaderNiTypeInfoFile': return { Headers: ['h', 'hpp'], 'All files': ['*'] }; case 'externalProcessPath': return { Executables: ['exe'], 'All files': ['*'] }; default: return { 'All files': ['*'] }; } }
