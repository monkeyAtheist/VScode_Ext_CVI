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

const TLB_HELP_STYLE_OPTIONS: SelectOption[] = [
  ['HLP', 'HLP'],
  ['CHM', 'CHM']
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
        const scope = parseScope(message.scope, this.selectedScope);
        this.selectedScope = scope;
        const settings = message.settings as CviProjectBuildSettings;
        const targetSettings = message.nativeTarget as CviNativeTargetSettings;
        if (typeof message.targetType === 'string') {
          targetSettings.targetType = message.targetType;
        }
        this.applyNativeTargetSettings(this.projectRef, scope, targetSettings);
        this.applyProjectSettings(this.projectRef, scope, settings);
        if (typeof message.buildLogDetail === 'string') {
          const detail = normalizeBuildLogDetail(message.buildLogDetail);
          await vscode.workspace.getConfiguration('labwindowsCvi').update('buildLogDetail', detail, vscode.ConfigurationTarget.Workspace);
        }
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
    const buildLogDetail = normalizeBuildLogDetail(vscode.workspace.getConfiguration('labwindowsCvi').get<string>('buildLogDetail', 'normal'));
    const logDetailOptions: SelectOption[] = [
      ['compact', 'Compact: phases, summary, warnings and errors'],
      ['normal', 'Normal: phases, durations and structured diagnostics'],
      ['verbose', 'Verbose: normal report plus commands and successful tool output']
    ];
    const settingsPages = [
      { id: 'overview', label: 'Overview', description: 'Project status and common CVI actions.' },
      { id: 'project', label: 'Project', description: 'Target type, output path and native .prj storage.' },
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
  <div class="toolbar"><div><label class="field">Edited build configuration<select id="configurationScope">${scopeOptions(mode)}</select></label><div class="muted">${mode === 'all' ? 'The entered values will be applied to Debug, Release, Debug64 and Release64.' : `Only ${escapeHtml(scopeLabel(mode))} will be modified.`}</div></div><div class="actions"><button id="save" type="button">Save CVI settings</button><button data-command="labwindowsCvi.editBuildSettingsSafeMode" class="secondary" type="button">Safe mode</button><button data-command="labwindowsCvi.openWorkspaceInCvi" class="secondary" type="button">Open in CVI</button></div></div>
  <nav id="pageNav" class="page-nav" aria-label="Settings pages">${pageNavigation}</nav>
  <div id="settingsNavigation" class="settings-nav"><input id="settingsFilter" type="search" placeholder="Filter settings on this page…" aria-label="Filter current settings page"><select id="sectionNav" aria-label="Jump to a section"><option value="">Jump to a section…</option></select><div class="page-context"><strong id="pageTitle">Overview</strong><span id="pageDescription">Project status and common CVI actions.</span><span id="dirtyState" class="dirty">Saved state</span></div></div>
</div>
<div class="grid">
<section id="section-control" data-settings-section data-settings-page="overview" data-settings-title="Control center" class="card wide"><h2>Project control center</h2><div class="control-grid"><div class="control-group"><h3>Build and run</h3><div class="actions"><button data-command="labwindowsCvi.build">Build</button><button data-command="labwindowsCvi.rebuild">Rebuild</button><button data-command="labwindowsCvi.clean">Clean</button><button data-command="labwindowsCvi.run">Run</button></div></div><div class="control-group"><h3>CVI native tools</h3><div class="actions"><button data-command="labwindowsCvi.openWorkspaceInCvi">Open in CVI</button><button data-command="labwindowsCvi.debugInCvi">Debug in CVI</button><button data-command="labwindowsCvi.configureInstallation">CVI path</button></div></div><div class="control-group"><h3>IntelliSense</h3><div class="actions"><button data-command="labwindowsCvi.syncCppTools">Sync</button><button data-command="labwindowsCvi.diagnoseCppTools">Diagnose</button></div></div><div class="control-group"><h3>Diagnostics</h3><div class="actions"><button data-command="labwindowsCvi.showBuildProblems">Problems</button><button data-command="labwindowsCvi.showFullBuildTrace">Build Trace</button></div></div></div><div class="notice">This editor is organized by thematic pages. Use the page bar for broad areas and <code>Jump to a section...</code> for local navigation.</div></section>
<section id="section-native-storage" data-settings-section data-settings-page="project" data-settings-title="Native project storage" class="card wide"><h2>Native project storage</h2><p class="muted">Native target settings are read from and written to the selected CVI <code>.prj</code> configuration. A timestamped backup is created before every native write. Project dependencies remain mirrored in <code>.vscode/labwindows-cvi-build.json</code> until a non-empty CVI dependency reference sample is available.</p><div class="pill-row"><span class="pill">Project: ${escapeHtml(ref.name)}</span><span class="pill">Scope: ${escapeHtml(scopeLabel(mode))}</span><span class="pill">Target: ${escapeHtml(target.targetType)}</span></div></section>
<section id="section-target" data-settings-section data-settings-page="project" data-settings-title="Target and output" class="card wide"><h2>Target and output</h2><div class="fields"><label class="field">Target type<select id="targetType">${targetOption('Executable', target.targetType)}${targetOption('Dynamic Link Library', target.targetType)}${targetOption('Static Library', target.targetType)}</select></label>${pathField('Output file', 'outputPath', target.outputPath)}</div><p class="muted">The output path applies to ${escapeHtml(scopeLabel(mode))} and is stored in the native CVI project file.</p><div class="target-note target-exe">Executable target: run/debug command-line options and executable metadata are active.</div><div class="target-note target-dll">DLL target: DLL copy, import-library, export and type-information options are active. Run options use an external host executable.</div><div class="target-note target-static">Static library target: runtime, DLL and executable launch options are not used.</div></section>
<section id="section-target-creation" data-settings-section data-settings-page="runtime" data-settings-title="Target creation options" class="card wide target-nonlib"><h2>Target creation options</h2><div class="section-body"><div class="two"><label class="field target-exe">Application title<input id="applicationTitle" value="${escapeHtml(target.applicationTitle)}"></label><div class="target-exe">${pathField('Application icon file', 'iconFile', target.iconFile)}</div>${selectField('Run-time support', 'runtimeSupport', target.runtimeSupport, RUNTIME_SUPPORT_OPTIONS)}${selectField('Run-time engine binding', 'runtimeBinding', target.runtimeBinding, runtimeBindingOptions)}${selectField('Generate help from source', 'generateSourceDocumentation', target.generateSourceDocumentation, SOURCE_DOCUMENTATION_OPTIONS)}<div id="manifestPathRow">${pathField('Manifest file', 'manifestPath', target.manifestPath)}</div></div><div class="inline"><label class="check"><input id="manifestEmbed" type="checkbox" ${checked(target.manifestEmbed)}> Embed manifest</label><label class="check"><input id="embedProjectUirs" type="checkbox" ${checked(target.embedProjectUirs)}> Embed project .UIRs</label><label class="check"><input id="generateMapFile" type="checkbox" ${checked(target.generateMapFile)}> Generate map file</label><label class="check target-exe"><input id="createConsoleApplication" type="checkbox" ${checked(target.createConsoleApplication)}> Create console application</label><label class="check"><input id="embedTimestamp" type="checkbox" ${checked(target.embedTimestamp)}> Embed timestamp</label></div></div></section>
<section id="loadExternalModuleSection" data-settings-section data-settings-page="runtime" data-settings-title="LoadExternalModule options" class="card wide target-nonlib"><h2>LoadExternalModule options</h2><div class="section-body"><p class="muted warning">Compatibility option retained by CVI. Enable the option, then add <code>.lib</code> or <code>.obj</code> modules. The preview is saved in the native <code>[Modules Forced Into Executable]</code> section.</p><p class="muted warning conditional-note">Unavailable when run-time support is set to Instrument driver only.</p><label class="check"><input id="usingLoadExternalModule" type="checkbox" ${checked(target.usingLoadExternalModule)}> Enable LoadExternalModule</label><input id="forcedModules" type="hidden" value="${escapeHtml(target.forcedModules.join('\n'))}"><div class="module-toolbar"><button id="addForcedModules" class="secondary" type="button">Add files to ${target.targetType === 'Dynamic Link Library' ? 'DLL' : 'executable'}…</button><button id="addForcedModuleName" class="secondary" type="button">Add module name…</button></div><div id="forcedModulesPreview" class="module-list"></div></div></section>
<section id="section-dll-options" data-settings-section data-settings-page="dll" data-settings-title="DLL copy, import library and exports" class="card wide target-dll"><h2>DLL copy, import library and exports</h2><div class="section-body"><div class="two"><div id="customDirectoryToCopyDllRow">${pathField('Custom copy directory', 'customDirectoryToCopyDll', target.customDirectoryToCopyDll)}</div>${selectField('Where to copy DLL', 'whereToCopyDll', target.whereToCopyDll, DLL_COPY_OPTIONS)}<label id="importLibBaseNameRow" class="field">Import library base name<input id="importLibBaseName" value="${escapeHtml(target.importLibBaseName)}"></label>${selectField('Export mode', 'dllExports', target.dllExports, DLL_EXPORT_OPTIONS)}</div><div class="inline"><label class="check"><input id="useDefaultImportLibBaseName" type="checkbox" ${checked(target.useDefaultImportLibBaseName)}> Use default import library base name</label><button id="openImportLibraryChoices" class="secondary" type="button">Import library choices…</button><span id="importLibraryChoicesSummary" class="muted"></span></div><div id="dllExportHeadersBlock" class="export-headers settings-subsection"><h3>Headers included in DLL exports</h3><p class="muted conditional-note">Unavailable when export mode is Symbols marked for export.</p>${exportFileChecks}</div></div></section>
<div id="importLibraryChoicesDialog" class="dialog-backdrop hidden" role="dialog" aria-modal="true" aria-labelledby="importLibraryChoicesTitle"><div class="dialog-card"><h3 id="importLibraryChoicesTitle">DLL Import Library Choices</h3><label class="check"><input id="useIviSubdirectoriesForImportLibraries" type="checkbox" ${checked(target.useIviSubdirectoriesForImportLibraries)}> Use IVI subdirectories</label><label class="check"><input id="useVxiPnpSubdirectoriesForImportLibraries" type="checkbox" ${checked(target.useVxiPnpSubdirectoriesForImportLibraries)}> Use VXIplug&amp;play subdirectories</label><div class="dialog-actions"><button id="confirmImportLibraryChoices" type="button">OK</button><button id="cancelImportLibraryChoices" class="secondary" type="button">Cancel</button></div></div></div>
<section id="section-dll-typeinfo" data-settings-section data-settings-page="dll" data-settings-title="DLL type information" class="card wide target-dll"><h2>DLL type information</h2><div class="section-body"><div id="typeLibraryResourceBlock" class="sub-block"><label class="check"><input id="addTypeLibToDll" type="checkbox" ${checked(target.addTypeLibToDll)}> Add type library resource to DLL</label><div class="nested-controls"><div class="inline"><label class="check"><input id="includeTypeLibHelpLinks" type="checkbox" ${checked(target.includeTypeLibHelpLinks)}> Include links to help file</label><label class="field compact-field">TLB help file<select id="tlbHelpStyle">${selectOptions(TLB_HELP_STYLE_OPTIONS, target.tlbHelpStyle)}</select></label></div><div id="typeLibFpFileRow">${pathField('Function panel file', 'typeLibFpFile', target.typeLibFpFile)}</div></div></div><div id="niTypeInfoResourceBlock" class="sub-block"><label class="check"><input id="addNiTypeInfoToDll" type="checkbox" ${checked(target.addNiTypeInfoToDll)}> Add NI Type Information resource to DLL</label><div class="nested-controls"><label class="check"><input id="niTypeInfoFromAllSources" name="niTypeInfoSource" type="radio" value="all" ${checked(!target.useSingleHeaderForNiTypeInfo)}> Data from all source files</label><label class="check"><input id="niTypeInfoFromSingleHeader" name="niTypeInfoSource" type="radio" value="single" ${checked(target.useSingleHeaderForNiTypeInfo)}> Data from single header file</label><div id="singleHeaderNiTypeInfoRow">${pathField('Header file', 'singleHeaderNiTypeInfoFile', target.singleHeaderNiTypeInfoFile)}</div></div></div></div></section>
<section id="section-version" data-settings-section data-settings-page="version" data-settings-title="Version information" class="card wide"><h2>Version information</h2><div class="section-body two">${textField('Numeric file version', 'numericFileVersion', target.versionInfo.numericFileVersion)}${textField('Numeric product version', 'numericProductVersion', target.versionInfo.numericProductVersion)}${textField('Comments', 'versionComments', target.versionInfo.comments)}${textField('Company name', 'companyName', target.versionInfo.companyName)}${textField('File description', 'fileDescription', target.versionInfo.fileDescription)}${textField('File version', 'fileVersion', target.versionInfo.fileVersion)}${textField('Internal name', 'internalName', target.versionInfo.internalName)}${textField('Legal copyright', 'legalCopyright', target.versionInfo.legalCopyright)}${textField('Legal trademarks', 'legalTrademarks', target.versionInfo.legalTrademarks)}${textField('Original filename', 'originalFilename', target.versionInfo.originalFilename)}${textField('Private build', 'privateBuild', target.versionInfo.privateBuild)}${textField('Product name', 'productName', target.versionInfo.productName)}${textField('Product version', 'productVersion', target.versionInfo.productVersion)}${textField('Special build', 'specialBuild', target.versionInfo.specialBuild)}</div></section>
<section id="section-signing" data-settings-section data-settings-page="version" data-settings-title="Signing information" class="card wide target-nonlib"><h2>Signing information</h2><div class="section-body"><label class="check"><input id="signEnabled" type="checkbox" ${checked(target.signing.enabled)}> Sign target</label><div id="signingDetailsBlock" class="nested-controls"><label class="check"><input id="signDebugBuild" type="checkbox" ${checked(target.signing.signDebugBuild)}> Sign debug build</label><div class="two">${textField('Certificate store', 'signStore', target.signing.store)}${textField('Certificate', 'signCertificate', target.signing.certificate)}${textField('Timestamp URL', 'signTimestampUrl', target.signing.timestampUrl)}${textField('Description URL', 'signDescriptionUrl', target.signing.descriptionUrl)}</div></div></div></section>
<section id="section-build-actions" data-settings-section data-settings-page="build" data-settings-title="Build actions" class="card wide"><h2>Build actions</h2><div class="section-body two"><label class="field">Pre-build actions<textarea id="preBuildActions">${escapeHtml(settings.preBuildActions.join('\n'))}</textarea></label><label class="field">Custom build actions<textarea id="customBuildActions">${escapeHtml(settings.customBuildActions.join('\n'))}</textarea></label><label class="field wide">Post-build actions<textarea id="postBuildActions">${escapeHtml(settings.postBuildActions.join('\n'))}</textarea></label></div></section>
<section id="runOptionsSection" data-settings-section data-settings-page="run" data-settings-title="Run and debug command line" class="card wide target-nonlib"><h2>Run and debug command line</h2><div class="fields">${textField('Command line arguments','arguments',settings.run.arguments,'--option value')}${pathField('Working directory','workingDirectory',settings.run.workingDirectory)}${textField('Environment options','environmentOptions',settings.run.environmentOptions,'NAME=value;OTHER=value')}<div id="externalProcessPathRow" class="target-dll">${pathField('External executable for DLL debugging','externalProcessPath',settings.run.externalProcessPath)}</div></div><p class="muted target-dll">DLL targets are not launched directly. These fields are used when an external host executable loads the DLL.</p></section>
<section id="section-dependencies" data-settings-section data-settings-page="dependencies" data-settings-title="Project dependencies and build order" class="card wide"><h2>Project dependencies and build order</h2><p class="muted">Checked projects are built before ${escapeHtml(ref.name)}.</p>${dependencies}</section>
<section id="section-log" data-settings-section data-settings-page="diagnostics" data-settings-title="Build logs and Problems" class="card wide"><h2>Build logs and Problems</h2><div class="fields">${selectField('Build log detail', 'buildLogDetail', buildLogDetail, logDetailOptions)}</div><p class="muted">The main <code>LabWindows/CVI</code> channel is the structured human-readable build report. Full raw commands, stdout, stderr, exit codes and timings remain available in <code>LabWindows/CVI - Build Trace</code>. Build diagnostics are also sent to <code>View → Problems</code> when CVI/compiler output can be parsed.</p><div class="actions"><button data-command="labwindowsCvi.showBuildProblems">Show Build Problems</button><button data-command="labwindowsCvi.showFullBuildTrace">Show Full Build Trace</button></div></section>
</div><div class="actions bottom"><button id="saveBottom" type="button">Save CVI settings</button></div>
<script>
const vscode=(window.__cviVsCodeApi||(window.__cviVsCodeApi=acquireVsCodeApi()));document.body.classList.add('settings-js-ready');const settingsPages=${settingsPageMetadata};const el=(id)=>document.getElementById(id);const val=(id)=>el(id)?.value||'';const flag=(id)=>!!el(id)?.checked;const lines=(id)=>val(id).replaceAll(String.fromCharCode(13),'').split(String.fromCharCode(10)).map(v=>v.trim()).filter(Boolean);const chosen=(selector)=>[...document.querySelectorAll(selector+':checked')].map(e=>e.value);let forcedModules=${JSON.stringify(target.forcedModules)};
const bindingOptions={"Executable":${JSON.stringify(EXE_RUNTIME_BINDING_OPTIONS)},"Dynamic Link Library":${JSON.stringify(DLL_RUNTIME_BINDING_OPTIONS)},"Static Library":[]};
const pageButtons=[...document.querySelectorAll('[data-settings-page-target]')];const sections=[...document.querySelectorAll('[data-settings-section]')];const sectionNav=el('sectionNav');const settingsFilter=el('settingsFilter');const pageTitle=el('pageTitle');const pageDescription=el('pageDescription');const dirtyState=el('dirtyState');let webviewState=(vscode&&typeof vscode.getState==='function'?vscode.getState():{})||{};let activePage=settingsPages.some(page=>page.id===webviewState.activePage)?webviewState.activePage:'overview';
const markDirty=()=>{if(dirtyState){dirtyState.textContent='Unsaved changes';dirtyState.classList.add('changed');}};const markSaved=()=>{if(dirtyState){dirtyState.textContent='Saved state';dirtyState.classList.remove('changed');}};
const populateSections=()=>{if(!sectionNav)return;sectionNav.innerHTML='<option value="">Jump to a section…</option>';sections.filter(section=>section.dataset.settingsPage===activePage&&!section.classList.contains('page-hidden')&&!section.classList.contains('filter-hidden')).forEach(section=>{const option=document.createElement('option');option.value=section.id;option.textContent=section.dataset.settingsTitle||section.id;sectionNav.appendChild(option);});};
const applyFilter=()=>{const query=(settingsFilter?.value||'').trim().toLowerCase();sections.forEach(section=>{const belongs=section.dataset.settingsPage===activePage;section.classList.toggle('page-hidden',!belongs);const text=((section.dataset.settingsTitle||'')+' '+section.textContent).toLowerCase();section.classList.toggle('filter-hidden',belongs&&!!query&&!text.includes(query));});populateSections();};
const activatePage=(pageId,scrollToTop=false)=>{const meta=settingsPages.find(page=>page.id===pageId)||settingsPages[0];activePage=meta.id;pageButtons.forEach(button=>{const selected=button.dataset.settingsPageTarget===activePage;button.classList.toggle('active',selected);button.setAttribute('aria-current',selected?'page':'false');});if(pageTitle)pageTitle.textContent=meta.label;if(pageDescription)pageDescription.textContent=meta.description;webviewState={...webviewState,activePage};if(vscode&&typeof vscode.setState==='function')vscode.setState(webviewState);applyFilter();if(scrollToTop)document.getElementById('settingsStickyHeader')?.scrollIntoView({block:'start'});};
const replaceOptions=(id,options)=>{const select=el(id);if(!select)return;const previous=select.value;select.innerHTML='';const values=[...options];if(previous&&!values.some(v=>v[0]===previous))values.push([previous,previous+' (existing value)']);for(const option of values){const node=document.createElement('option');node.value=option[0];node.textContent=option[1];if(option[0]===previous)node.selected=true;select.appendChild(node);}};
const isInstrumentDriverOnly=()=>val('runtimeSupport')==='Instrument Driver Support Only';const updateForcedModuleControls=()=>{const unavailable=isInstrumentDriverOnly();const enabled=!unavailable&&flag('usingLoadExternalModule');const zone=el('loadExternalModuleSection');if(zone){zone.classList.toggle('disabled-zone',unavailable);zone.setAttribute('aria-disabled',String(unavailable));}if(el('usingLoadExternalModule'))el('usingLoadExternalModule').disabled=unavailable;for(const id of ['addForcedModules','addForcedModuleName'])if(el(id))el(id).disabled=!enabled;for(const button of document.querySelectorAll('.module-remove'))button.disabled=!enabled;const targetLabel=val('targetType')==='Dynamic Link Library'?'DLL':'executable';if(el('addForcedModules'))el('addForcedModules').textContent='Add files to '+targetLabel+'…';};
const disableField=(id,disabled)=>{const node=el(id);if(node)node.disabled=disabled;};const disableBrowse=(field,disabled)=>{const button=document.querySelector('[data-browse-field="'+field+'"]');if(button)button.disabled=disabled;};const toggleDisabledZone=(id,disabled)=>{const zone=el(id);if(zone){zone.classList.toggle('disabled-control-zone',disabled);zone.setAttribute('aria-disabled',String(disabled));}};const updateImportLibraryChoicesSummary=()=>{const values=[];if(flag('useIviSubdirectoriesForImportLibraries'))values.push('IVI');if(flag('useVxiPnpSubdirectoriesForImportLibraries'))values.push('VXIplug&play');if(el('importLibraryChoicesSummary'))el('importLibraryChoicesSummary').textContent=values.length?values.join(' · '):'No import-library subdirectory';};const updateTargetCreationControls=()=>{const manifestEnabled=flag('manifestEmbed');disableField('manifestPath',!manifestEnabled);disableBrowse('manifestPath',!manifestEnabled);toggleDisabledZone('manifestPathRow',!manifestEnabled);};const updateDllOptionControls=()=>{const useDefault=flag('useDefaultImportLibBaseName');disableField('importLibBaseName',useDefault);toggleDisabledZone('importLibBaseNameRow',useDefault);const customDirectory=val('whereToCopyDll')==='Custom directory';disableField('customDirectoryToCopyDll',!customDirectory);disableBrowse('customDirectoryToCopyDll',!customDirectory);toggleDisabledZone('customDirectoryToCopyDllRow',!customDirectory);const headersEnabled=val('dllExports')!=='Symbols Marked As Export';const block=el('dllExportHeadersBlock');if(block){block.classList.toggle('disabled-sub-block',!headersEnabled);block.setAttribute('aria-disabled',String(!headersEnabled));}for(const input of document.querySelectorAll('[data-export-file]'))input.disabled=!headersEnabled;updateImportLibraryChoicesSummary();};let importChoicesSnapshot={ivi:false,vxi:false};const showImportLibraryChoices=()=>{importChoicesSnapshot={ivi:flag('useIviSubdirectoriesForImportLibraries'),vxi:flag('useVxiPnpSubdirectoriesForImportLibraries')};el('importLibraryChoicesDialog')?.classList.remove('hidden');};const hideImportLibraryChoices=(restore)=>{if(restore){if(el('useIviSubdirectoriesForImportLibraries'))el('useIviSubdirectoriesForImportLibraries').checked=importChoicesSnapshot.ivi;if(el('useVxiPnpSubdirectoriesForImportLibraries'))el('useVxiPnpSubdirectoriesForImportLibraries').checked=importChoicesSnapshot.vxi;}el('importLibraryChoicesDialog')?.classList.add('hidden');updateImportLibraryChoicesSummary();};const updateDllTypeInformationControls=()=>{const typeLibEnabled=flag('addTypeLibToDll');const helpLinksEnabled=typeLibEnabled&&flag('includeTypeLibHelpLinks');const typeBlock=el('typeLibraryResourceBlock');if(typeBlock){typeBlock.classList.toggle('disabled-sub-block',!typeLibEnabled);typeBlock.setAttribute('aria-disabled',String(!typeLibEnabled));}disableField('includeTypeLibHelpLinks',!typeLibEnabled);disableField('tlbHelpStyle',!helpLinksEnabled);disableField('typeLibFpFile',!typeLibEnabled);disableBrowse('typeLibFpFile',!typeLibEnabled);const niEnabled=flag('addNiTypeInfoToDll');const singleHeader=niEnabled&&flag('niTypeInfoFromSingleHeader');const niBlock=el('niTypeInfoResourceBlock');if(niBlock){niBlock.classList.toggle('disabled-sub-block',!niEnabled);niBlock.setAttribute('aria-disabled',String(!niEnabled));}disableField('niTypeInfoFromAllSources',!niEnabled);disableField('niTypeInfoFromSingleHeader',!niEnabled);const headerRow=el('singleHeaderNiTypeInfoRow');if(headerRow)headerRow.classList.toggle('hidden',!singleHeader);disableField('singleHeaderNiTypeInfoFile',!singleHeader);disableBrowse('singleHeaderNiTypeInfoFile',!singleHeader);};const updateSigningControls=()=>{const enabled=flag('signEnabled');toggleDisabledZone('signingDetailsBlock',!enabled);for(const id of ['signDebugBuild','signStore','signCertificate','signTimestampUrl','signDescriptionUrl'])disableField(id,!enabled);};const updateExecutableCommandLineControls=()=>{const dll=val('targetType')==='Dynamic Link Library';disableField('externalProcessPath',!dll);disableBrowse('externalProcessPath',!dll);toggleDisabledZone('externalProcessPathRow',!dll);};
const renderForcedModules=()=>{forcedModules=[...new Set(forcedModules.map(v=>String(v).trim()).filter(Boolean))];if(el('forcedModules'))el('forcedModules').value=forcedModules.join(String.fromCharCode(10));const host=el('forcedModulesPreview');if(!host)return;host.innerHTML='';if(!forcedModules.length){const empty=document.createElement('div');empty.className='empty-modules';empty.textContent='No module is currently included.';host.appendChild(empty);updateForcedModuleControls();return;}forcedModules.forEach((value,index)=>{const row=document.createElement('div');row.className='module-row';const label=document.createElement('span');label.textContent=value;label.title=value;const remove=document.createElement('button');remove.type='button';remove.className='module-remove';remove.textContent='Remove';remove.addEventListener('click',()=>{forcedModules.splice(index,1);renderForcedModules();markDirty();});row.append(label,remove);host.appendChild(row);});updateForcedModuleControls();};
const updateTargetControls=()=>{document.body.dataset.target=val('targetType');replaceOptions('runtimeBinding',bindingOptions[val('targetType')]||[]);updateForcedModuleControls();updateTargetCreationControls();updateDllOptionControls();updateDllTypeInformationControls();updateSigningControls();updateExecutableCommandLineControls();applyFilter();};
document.querySelectorAll('[data-browse-field]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:'browse',field:button.dataset.browseField})));const pageNavHost=el('pageNav')||document;pageNavHost.addEventListener('click',(event)=>{const target=event.target&&event.target.closest?event.target.closest('[data-settings-page-target]'):null;if(!target)return;const page=target.dataset.settingsPageTarget;if(!page)return;event.preventDefault();event.stopPropagation();activatePage(page,true);});document.querySelectorAll('[data-command]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:'command',command:button.dataset.command})));sectionNav?.addEventListener('change',()=>{const id=sectionNav.value;if(id)document.getElementById(id)?.scrollIntoView({behavior:'smooth',block:'start'});sectionNav.value='';});settingsFilter?.addEventListener('input',applyFilter);document.querySelectorAll('input,select,textarea').forEach(node=>node.addEventListener('input',markDirty));
el('targetType')?.addEventListener('change',updateTargetControls);el('configurationScope')?.addEventListener('change',()=>vscode.postMessage({type:'changeScope',scope:val('configurationScope')}));el('runtimeSupport')?.addEventListener('change',updateForcedModuleControls);el('manifestEmbed')?.addEventListener('change',updateTargetCreationControls);el('useDefaultImportLibBaseName')?.addEventListener('change',updateDllOptionControls);el('whereToCopyDll')?.addEventListener('change',updateDllOptionControls);el('dllExports')?.addEventListener('change',updateDllOptionControls);el('openImportLibraryChoices')?.addEventListener('click',showImportLibraryChoices);el('confirmImportLibraryChoices')?.addEventListener('click',()=>hideImportLibraryChoices(false));el('cancelImportLibraryChoices')?.addEventListener('click',()=>hideImportLibraryChoices(true));el('importLibraryChoicesDialog')?.addEventListener('click',(event)=>{if(event.target===el('importLibraryChoicesDialog'))hideImportLibraryChoices(true);});el('usingLoadExternalModule')?.addEventListener('change',updateForcedModuleControls);el('addTypeLibToDll')?.addEventListener('change',updateDllTypeInformationControls);el('includeTypeLibHelpLinks')?.addEventListener('change',updateDllTypeInformationControls);el('addNiTypeInfoToDll')?.addEventListener('change',updateDllTypeInformationControls);el('niTypeInfoFromAllSources')?.addEventListener('change',updateDllTypeInformationControls);el('niTypeInfoFromSingleHeader')?.addEventListener('change',updateDllTypeInformationControls);el('signEnabled')?.addEventListener('change',updateSigningControls);el('addForcedModules')?.addEventListener('click',()=>vscode.postMessage({type:'browseForcedModules'}));el('addForcedModuleName')?.addEventListener('click',()=>vscode.postMessage({type:'promptForcedModuleName'}));
window.addEventListener('message',(event)=>{const message=event.data;if(message?.type==='setField'&&el(message.field)){el(message.field).value=message.value||'';markDirty();}if(message?.type==='appendForcedModules'&&Array.isArray(message.values)){forcedModules.push(...message.values);renderForcedModules();markDirty();}});
const collectBuildParameters=()=>({type:'save',scope:val('configurationScope'),targetType:val('targetType'),buildLogDetail:val('buildLogDetail'),settings:{preBuildActions:lines('preBuildActions'),customBuildActions:lines('customBuildActions'),postBuildActions:lines('postBuildActions'),dependencies:[...document.querySelectorAll('[data-dependency]:checked')].map(e=>e.dataset.dependency),run:{arguments:val('arguments'),workingDirectory:val('workingDirectory'),environmentOptions:val('environmentOptions'),externalProcessPath:val('externalProcessPath')}},nativeTarget:{targetType:val('targetType'),outputPath:val('outputPath'),applicationTitle:val('applicationTitle'),iconFile:val('iconFile'),runtimeSupport:val('runtimeSupport'),runtimeBinding:val('runtimeBinding'),generateSourceDocumentation:val('generateSourceDocumentation'),manifestEmbed:flag('manifestEmbed'),manifestPath:val('manifestPath'),embedProjectUirs:flag('embedProjectUirs'),generateMapFile:flag('generateMapFile'),createConsoleApplication:flag('createConsoleApplication'),embedTimestamp:flag('embedTimestamp'),usingLoadExternalModule:flag('usingLoadExternalModule'),forcedModules:lines('forcedModules'),useDefaultImportLibBaseName:flag('useDefaultImportLibBaseName'),importLibBaseName:val('importLibBaseName'),whereToCopyDll:val('whereToCopyDll'),customDirectoryToCopyDll:val('customDirectoryToCopyDll'),useIviSubdirectoriesForImportLibraries:flag('useIviSubdirectoriesForImportLibraries'),useVxiPnpSubdirectoriesForImportLibraries:flag('useVxiPnpSubdirectoriesForImportLibraries'),dllExports:val('dllExports'),exportFiles:chosen('[data-export-file]'),addTypeLibToDll:flag('addTypeLibToDll'),includeTypeLibHelpLinks:flag('includeTypeLibHelpLinks'),tlbHelpStyle:val('tlbHelpStyle'),typeLibFpFile:val('typeLibFpFile'),addNiTypeInfoToDll:flag('addNiTypeInfoToDll'),useSingleHeaderForNiTypeInfo:flag('niTypeInfoFromSingleHeader'),singleHeaderNiTypeInfoFile:val('singleHeaderNiTypeInfoFile'),versionInfo:{numericFileVersion:val('numericFileVersion'),numericProductVersion:val('numericProductVersion'),comments:val('versionComments'),companyName:val('companyName'),fileDescription:val('fileDescription'),fileVersion:val('fileVersion'),internalName:val('internalName'),legalCopyright:val('legalCopyright'),legalTrademarks:val('legalTrademarks'),originalFilename:val('originalFilename'),privateBuild:val('privateBuild'),productName:val('productName'),productVersion:val('productVersion'),specialBuild:val('specialBuild')},signing:{enabled:flag('signEnabled'),store:val('signStore'),certificate:val('signCertificate'),timestampUrl:val('signTimestampUrl'),descriptionUrl:val('signDescriptionUrl'),signDebugBuild:flag('signDebugBuild')}}});
const saveNow=()=>{markSaved();vscode.postMessage(collectBuildParameters());};el('save')?.addEventListener('click',saveNow);el('saveBottom')?.addEventListener('click',saveNow);
renderForcedModules();updateTargetControls();activatePage(activePage,false);
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
function normalizeBuildLogDetail(value: string | undefined): 'compact' | 'normal' | 'verbose' { return value === 'compact' || value === 'verbose' ? value : 'normal'; }
function safeScriptJson(value: unknown): string { return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026'); }
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

function portableModulePath(filePath: string, projectDirectory: string): string { const relative = path.relative(projectDirectory, filePath); if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) { return relative.replace(/\//g, '\\'); } return filePath; }
