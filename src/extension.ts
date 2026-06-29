import * as path from 'path';
import * as vscode from 'vscode';
import { CviParser } from './model/cviParser';
import { CviTreeProvider, FileNode, FolderNode, ProjectNode } from './providers/cviTreeProvider';
import { CviFileSymbolsProvider } from './providers/cviFileSymbolsProvider';
import { CviBuildService } from './services/cviBuildService';
import { CviCppToolsService } from './services/cviCppToolsService';
import { CviInstallationService } from './services/cviInstallationService';
import { CviWorkspaceService } from './services/cviWorkspaceService';
import { HomePanel } from './views/homePanel';
import { activate as activateCviLibraryExplorer } from './jcLibEmbedded';
import { ensureBundledCviLibraryPack } from './services/cviLibraryPackService';
import { CviTemplateService } from './services/cviTemplateService';
import { CviProjectSettingsService } from './services/cviProjectSettingsService';
import { BuildSettingsPanel } from './views/buildSettingsPanel';
import { QuickActionsView } from './views/quickActionsView';
import { CviDebugView } from './views/cviDebugView';
import { CviCompletionProvider, CviSourceSymbol, CviSymbolService, isSourceOrHeader } from './services/cviSymbolService';
import { CviFunctionPanelService } from './services/cviFunctionPanelService';
import { CviBreakpointSyncService } from './services/cviBreakpointSyncService';
import { CviNativeCommandService } from './services/cviNativeCommandService';
import { CviColorValueService } from './services/cviColorValueService';
import { CviContextToolsService } from './services/cviContextToolsService';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('LabWindows/CVI');
  const parser = new CviParser();
  const installations = new CviInstallationService(output);
  const cppTools = new CviCppToolsService(installations, parser, output);
  const templates = new CviTemplateService(context, installations, output);
  const workspaces = new CviWorkspaceService(context, parser, installations, templates, output);
  const projectSettings = new CviProjectSettingsService(workspaces, parser, output);
  const breakpointSync = new CviBreakpointSyncService(context, parser, workspaces, output);
  const nativeCommands = new CviNativeCommandService(context, workspaces, installations, breakpointSync, output);
  const colorValues = new CviColorValueService();
  const contextTools = new CviContextToolsService(context);
  const builds = new CviBuildService(parser, workspaces, installations, projectSettings, breakpointSync, output);
  const treeProvider = new CviTreeProvider(workspaces);
  const treeView = vscode.window.createTreeView('labwindowsCvi.workspaceExplorer', { treeDataProvider: treeProvider, showCollapseAll: true });
  const symbols = new CviSymbolService(context.extensionPath, workspaces);
  const fileSymbolsProvider = new CviFileSymbolsProvider(symbols);
  const fileSymbolsView = vscode.window.createTreeView('labwindowsCvi.fileSymbols', { treeDataProvider: fileSymbolsProvider });
  fileSymbolsProvider.attachView(fileSymbolsView);
  const completionProvider = new CviCompletionProvider(symbols);
  const functionPanels = new CviFunctionPanelService();
  const completionRegistration = vscode.languages.registerCompletionItemProvider(
    [{ language: 'c', scheme: 'file' }, { language: 'cpp', scheme: 'file' }],
    completionProvider
  );
  const home = new HomePanel(context, workspaces, builds, installations);
  const buildSettings = new BuildSettingsPanel(workspaces, parser, projectSettings);
  const quickActions = new QuickActionsView(workspaces, builds, projectSettings);
  const quickActionsRegistration = vscode.window.registerTreeDataProvider('labwindowsCvi.quickActions', quickActions);
  const debugView = new CviDebugView(nativeCommands, workspaces);
  const debugViewRegistration = vscode.window.registerTreeDataProvider('labwindowsCvi.debugControls', debugView);

  const statusBarItems = [
    createStatusBarAction('$(home)', 'LabWindows/CVI home', 'labwindowsCvi.openHome', 99),
    createStatusBarAction('$(folder-opened)', 'Open a CVI workspace or project', 'labwindowsCvi.openWorkspace', 98),
    createStatusBarAction('$(tools)', 'Build / rebuild / clean the active CVI project', 'labwindowsCvi.chooseBuildAction', 97),
    createStatusBarAction('$(play)', 'Build and run the active CVI target', 'labwindowsCvi.run', 96),
    createStatusBarAction('$(list-selection)', 'Advanced CVI run options', 'labwindowsCvi.chooseRunAction', 95),
    createStatusBarAction('$(debug-alt-small)', 'Native CVI debug controls', 'labwindowsCvi.chooseNativeDebugAction', 94.5),
    createStatusBarAction('D32', 'Select the LabWindows/CVI build mode', 'labwindowsCvi.selectBuildMode', 94),
    createStatusBarAction('EXE', 'Select the LabWindows/CVI target type', 'labwindowsCvi.selectTargetType', 93)
  ];

  const updateToolbarContexts = (): void => {
    const activeRef = workspaces.activeProjectRef;
    const targetType = activeRef?.exists ? workspaces.getProject(activeRef)?.targetType : undefined;
    const targetKey = targetType === 'Dynamic Link Library' ? 'dll' : targetType === 'Static Library' ? 'lib' : targetType === 'Executable' ? 'exe' : 'none';
    const nativeSnapshot = nativeCommands.getDebugSnapshot();
    void vscode.commands.executeCommand('setContext', 'labwindowsCvi.buildMode', builds.buildMode);
    void vscode.commands.executeCommand('setContext', 'labwindowsCvi.targetType', targetKey);
    void vscode.commands.executeCommand('setContext', 'labwindowsCvi.nativeExecution', nativeSnapshot.execution);
    void vscode.commands.executeCommand('setContext', 'labwindowsCvi.nativeSessionConnected', nativeSnapshot.sessionConnected);
  };

  const updateStatusBar = (): void => {
    const targetType = workspaces.activeProject?.targetType;
    const nativeSnapshot = nativeCommands.getDebugSnapshot();
    const modeText = builds.buildMode === 'debug64' ? 'D64' : builds.buildMode === 'release64' ? 'R64' : builds.buildMode === 'release' ? 'R32' : 'D32';
    const targetText = targetType === 'Dynamic Link Library' ? 'DLL' : targetType === 'Static Library' ? 'LIB' : targetType === 'Executable' ? 'EXE' : '---';
    const nativeBridgeAvailable = nativeSnapshot.sessionConnected || nativeSnapshot.serverAvailable === true;
    const nativeStateText = nativeBridgeAvailable
      ? nativeSnapshot.execution === 'running' ? 'run' : nativeSnapshot.execution === 'suspended' ? 'pause' : nativeSnapshot.execution === 'idle' ? 'idle' : '?'
      : 'off';
    const nativeStateIcon = nativeBridgeAvailable
      ? nativeSnapshot.execution === 'running' ? 'debug-start' : nativeSnapshot.execution === 'suspended' ? 'debug-pause' : 'debug-stop'
      : 'debug-disconnect';
    statusBarItems[5].text = `$(${nativeStateIcon}) CVI:${nativeStateText}`;
    statusBarItems[5].tooltip = `Native CVI debugger: ${nativeBridgeAvailable ? 'bridge available' : 'bridge unavailable'} · persistent session ${nativeSnapshot.sessionConnected ? 'connected' : 'disconnected'} · execution ${nativeSnapshot.execution} · last command ${nativeSnapshot.lastCommand}. Click for controls.`;
    statusBarItems[6].text = modeText;
    statusBarItems[6].tooltip = `LabWindows/CVI build mode: ${modeText}. Click to change.`;
    statusBarItems[7].text = targetText;
    statusBarItems[7].tooltip = `LabWindows/CVI target type: ${targetText}. Click to change.`;
    const show = vscode.workspace.getConfiguration('labwindowsCvi').get<boolean>('showPersistentStatusBarActions', true);
    for (const item of statusBarItems) {
      if (show) item.show(); else item.hide();
    }
    updateToolbarContexts();
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

  const runNativeDebug = async (): Promise<boolean> => {
    const shouldBuild = vscode.workspace.getConfiguration('labwindowsCvi').get<boolean>('buildBeforeNativeDebug', true);
    if (shouldBuild) {
      output.appendLine('[CVI] Running local compile.exe preflight build before native debugging.');
      const built = await builds.build(false);
      if (!built) {
        output.appendLine('[CVI] Native debugger launch cancelled: local compile.exe preflight build failed.');
        vscode.window.showErrorMessage('Native CVI debugger was not opened because the local compile.exe build failed.');
        return false;
      }
      output.appendLine('[CVI] Local compile.exe preflight build succeeded. Opening the native CVI debugger.');
    }
    return await nativeCommands.run();
  };

  context.subscriptions.push(
    output,
    nativeCommands,
    workspaces,
    home,
    buildSettings,
    quickActions,
    quickActionsRegistration,
    debugView,
    debugViewRegistration,
    cppTools,
    treeView,
    fileSymbolsView,
    completionRegistration,
    ...statusBarItems,
    treeView.onDidChangeSelection((event) => {
      const selected = event.selection[0];
      if (selected?.kind === 'file' && isSourceOrHeader(selected.file.absolutePath)) {
        fileSymbolsProvider.setSelectedFile(selected.file.absolutePath);
      }
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor?.document.uri.scheme === 'file' && isSourceOrHeader(editor.document.uri.fsPath)) {
        fileSymbolsProvider.setSelectedFile(editor.document.uri.fsPath);
      }
    }),
    workspaces.onDidChange(() => {
      symbols.invalidateProjectCache();
      fileSymbolsProvider.refresh();
      updateStatusBar();
      void cppTools.ensureConfigurationRootInWorkspace(workspaces.currentWorkspace).finally(() => {
        cppTools.requestSync(workspaces.currentWorkspace);
      });
    }),
    nativeCommands.onDidChange(() => updateStatusBar()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('labwindowsCvi')) {
        updateStatusBar();
        home.update();
        quickActions.update();
      }
      if (event.affectsConfiguration('labwindowsCvi.activeInstallation') || event.affectsConfiguration('labwindowsCvi.autoConfigureCppTools') || event.affectsConfiguration('labwindowsCvi.autoAddCviFolderToWorkspace') || event.affectsConfiguration('labwindowsCvi.useCppToolsConfigurationProvider') || event.affectsConfiguration('labwindowsCvi.intelliSenseCompilerPath') || event.affectsConfiguration('labwindowsCvi.additionalIncludePaths')) {
        void cppTools.ensureConfigurationRootInWorkspace(workspaces.currentWorkspace).finally(() => {
          cppTools.requestSync(workspaces.currentWorkspace);
        });
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
    register('labwindowsCvi.diagnoseCppTools', () => cppTools.diagnose(workspaces.currentWorkspace)),
    register('labwindowsCvi.repairCppToolsProvider', () => cppTools.repairCppToolsProviderSelection(workspaces.currentWorkspace)),
    register('labwindowsCvi.repairNativeWorkspaceCompatibility', () => workspaces.repairNativeWorkspaceCompatibility()),
    register('labwindowsCvi.synchronizeBreakpoints', (node?: ProjectNode) => breakpointSync.synchronize(node?.ref)),
    register('labwindowsCvi.clearSynchronizedBreakpoints', (node?: ProjectNode) => breakpointSync.clear(node?.ref)),
    register('labwindowsCvi.diagnoseBreakpointBridge', (node?: ProjectNode) => breakpointSync.diagnose(node?.ref)),
    register('labwindowsCvi.chooseNativeDebugAction', () => nativeCommands.chooseAction()),
    register('labwindowsCvi.nativeBuild', () => builds.build(false)),
    register('labwindowsCvi.nativeRun', async () => runNativeDebug()),
    register('labwindowsCvi.nativePause', () => nativeCommands.pause()),
    register('labwindowsCvi.nativeContinue', () => nativeCommands.continueExecution()),
    register('labwindowsCvi.nativeStop', () => nativeCommands.stop()),
    register('labwindowsCvi.nativeState', () => nativeCommands.showState()),
    register('labwindowsCvi.refreshNativeDebugView', () => nativeCommands.refreshDebugSnapshot()),
    register('labwindowsCvi.diagnoseNativeCommandBridge', () => nativeCommands.diagnose()),
    register('labwindowsCvi.addWorkspaceFolderForIntelliSense', () => cppTools.addConfigurationRootToWorkspace(workspaces.currentWorkspace)),
    register('labwindowsCvi.selectBuildMode', () => builds.selectBuildMode()),
    register('labwindowsCvi.selectBuildModeD32', () => builds.selectBuildMode()),
    register('labwindowsCvi.selectBuildModeR32', () => builds.selectBuildMode()),
    register('labwindowsCvi.selectBuildModeD64', () => builds.selectBuildMode()),
    register('labwindowsCvi.selectBuildModeR64', () => builds.selectBuildMode()),
    register('labwindowsCvi.chooseBuildAction', () => builds.chooseBuildAction()),
    register('labwindowsCvi.build', () => builds.build(false)),
    register('labwindowsCvi.rebuild', () => builds.build(true)),
    register('labwindowsCvi.clean', () => builds.clean()),
    register('labwindowsCvi.run', () => builds.buildAndRun()),
    register('labwindowsCvi.chooseRunAction', () => builds.chooseRunAction()),
    register('labwindowsCvi.runWithoutBuild', () => builds.runWithoutBuild()),
    register('labwindowsCvi.debugInCvi', () => runNativeDebug()),
    register('labwindowsCvi.openWorkspaceInCvi', () => builds.openWorkspaceInCvi()),
    register('labwindowsCvi.setActiveProject', (node?: ProjectNode) => workspaces.setActiveProject(node?.ref)),
    register('labwindowsCvi.buildProject', (node?: ProjectNode) => node ? builds.build(false, node.ref) : undefined),
    register('labwindowsCvi.rebuildProject', (node?: ProjectNode) => node ? builds.build(true, node.ref) : undefined),
    register('labwindowsCvi.cleanProject', (node?: ProjectNode) => node ? builds.clean(node.ref) : undefined),
    register('labwindowsCvi.selectTargetType', (node?: ProjectNode) => workspaces.selectTargetType(node?.ref)),
    register('labwindowsCvi.selectTargetTypeEXE', () => workspaces.selectTargetType()),
    register('labwindowsCvi.selectTargetTypeDLL', () => workspaces.selectTargetType()),
    register('labwindowsCvi.selectTargetTypeLIB', () => workspaces.selectTargetType()),
    register('labwindowsCvi.editBuildSettings', (node?: ProjectNode) => buildSettings.show(node?.ref)),
    register('labwindowsCvi.editBuildSettingsSafeMode', (node?: ProjectNode) => buildSettings.showSafeMode(node?.ref)),
    register('labwindowsCvi.executeProject', (node?: ProjectNode) => node ? builds.buildAndRun(node.ref) : undefined),
    register('labwindowsCvi.debugProjectInCvi', async (node?: ProjectNode) => { if (node?.ref) await workspaces.setActiveProject(node.ref); return await runNativeDebug(); }),
    register('labwindowsCvi.editProjectInCvi', (node?: ProjectNode) => node ? builds.openProjectInCvi(node.ref.absolutePath) : undefined),
    register('labwindowsCvi.openProjectFile', (node?: ProjectNode) => node ? workspaces.openPath(node.ref.absolutePath) : undefined),
    register('labwindowsCvi.createProjectInWorkspace', () => workspaces.createProjectInWorkspace()),
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
    register('labwindowsCvi.generatePrototypes', (node?: FileNode) => node ? workspaces.generatePrototypes(node.ref, node.file) : undefined),
    register('labwindowsCvi.prepareDllImportLibraryGeneration', (node?: FileNode) => node ? builds.prepareDllImportLibraryGeneration(node.file.absolutePath) : undefined),
    register('labwindowsCvi.refreshFileSymbols', () => fileSymbolsProvider.refresh()),
    register('labwindowsCvi.revealFileSymbol', (symbol?: CviSourceSymbol) => symbol ? fileSymbolsProvider.reveal(symbol) : undefined),
    register('labwindowsCvi.saveFile', (node?: FileNode) => node ? workspaces.saveFile(node.file.absolutePath) : undefined),
    register('labwindowsCvi.openPanelInCvi', (node?: FileNode) => node ? builds.openPanelInCvi(node.file.absolutePath) : undefined),
    register('labwindowsCvi.openPanelPathInCvi', (filePath?: string) => filePath ? builds.openPanelInCvi(filePath) : undefined),
    register('labwindowsCvi.openFunctionPanel', (node?: FileNode) => node ? functionPanels.open(node.file.absolutePath) : undefined),
    register('labwindowsCvi.insertSnippet', () => templates.insertSnippet()),
    register('labwindowsCvi.saveSelectionAsSnippet', () => templates.saveSelectionAsSnippet()),
    register('labwindowsCvi.manageSnippets', () => templates.manageSnippets()),
    register('labwindowsCvi.context.insertSnippet', () => templates.insertSnippet()),
    register('labwindowsCvi.context.saveSelectionAsSnippet', () => templates.saveSelectionAsSnippet()),
    register('labwindowsCvi.context.manageSnippets', () => templates.manageSnippets()),
    register('labwindowsCvi.context.insertFileHeader', () => templates.insertFileDescriptionHeader()),
    register('labwindowsCvi.context.insertCommentSection', () => templates.insertCommentSection()),
    register('labwindowsCvi.context.insertHeaderChangeEntry', () => templates.insertHeaderChangeEntry()),
    register('labwindowsCvi.context.insertSpecialCharacterText', () => templates.insertSpecialCharacterText()),
    register('labwindowsCvi.context.insertColorValue', () => colorValues.openColorValuePicker()),
    register('labwindowsCvi.context.openCharacterTable', () => contextTools.openCharacterTable()),
    register('labwindowsCvi.context.convertSelectedTextToDecimalValues', () => contextTools.convertSelectedTextToDecimalValues()),
    register('labwindowsCvi.context.convertSelectedNumbersToText', () => contextTools.convertSelectedNumbersToText()),
    register('labwindowsCvi.context.openNumberConverter', () => contextTools.openNumberConverter()),
    register('labwindowsCvi.context.openTruthTableDesigner', () => contextTools.openTruthTableDesigner()),
    register('labwindowsCvi.context.openDigitalFilterDesigner', () => contextTools.openDigitalFilterDesigner()),
    register('labwindowsCvi.saveFileAsTemplate', (node?: FileNode) => templates.saveCurrentFileAsTemplate(node?.file.absolutePath)),
    register('labwindowsCvi.importFileTemplate', () => templates.importFileTemplate()),
    register('labwindowsCvi.manageFileTemplates', () => templates.manageFileTemplates()),
    register('labwindowsCvi.openFile', (node?: FileNode) => node ? workspaces.openPath(node.file.absolutePath) : undefined),
    register('labwindowsCvi.revealProjectFile', (node?: ProjectNode) => node ? workspaces.revealInExplorer(node.ref.absolutePath) : undefined),
    register('labwindowsCvi.revealFile', (node?: FileNode) => node ? workspaces.revealInExplorer(node.file.absolutePath) : undefined),
    register('labwindowsCvi.copyFilePath', (node?: FileNode) => node ? workspaces.copyFilePath(node.file.absolutePath) : undefined),
    register('labwindowsCvi.copyRelativeFilePath', (node?: FileNode) => node ? workspaces.copyRelativeFilePath(node.ref, node.file.absolutePath) : undefined),
    register('labwindowsCvi.convertSelectedIntegerToDecimal', () => convertSelectedIntegerLiteral('decimal')),
    register('labwindowsCvi.convertSelectedIntegerToHexadecimal', () => convertSelectedIntegerLiteral('hexadecimal')),
    register('labwindowsCvi.convertSelectedIntegerToBinary', () => convertSelectedIntegerLiteral('binary')),
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

  ensureBundledCviLibraryPack(context, output);
  activateCviLibraryExplorer(context);

  await workspaces.restoreOrAutoLoad();
  const repairedProvider = await cppTools.autoRepairStaleProviderSelection(workspaces.currentWorkspace);
  await cppTools.ensureConfigurationRootInWorkspace(workspaces.currentWorkspace);
  await cppTools.sync(workspaces.currentWorkspace);
  if (repairedProvider) {
    void vscode.window.showWarningMessage(
      'LabWindows/CVI removed an obsolete C/C++ configuration provider reference that could disable normal completion outside CVI projects. Reload VS Code, then run C/C++: Reset IntelliSense Database once.',
      'Reload Window'
    ).then((action) => action === 'Reload Window' ? vscode.commands.executeCommand('workbench.action.reloadWindow') : undefined);
  }
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor?.document.uri.scheme === 'file' && isSourceOrHeader(activeEditor.document.uri.fsPath)) {
    fileSymbolsProvider.setSelectedFile(activeEditor.document.uri.fsPath);
  }
  updateStatusBar();
}

function createStatusBarAction(text: string, tooltip: string, command: string, priority: number): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority);
  item.text = text;
  item.tooltip = tooltip;
  item.command = command;
  return item;
}

type IntegerLiteralTarget = 'decimal' | 'hexadecimal' | 'binary';

async function convertSelectedIntegerLiteral(target: IntegerLiteralTarget): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    vscode.window.showInformationMessage('Select an integer literal before converting it.');
    return;
  }
  const selectedText = editor.document.getText(editor.selection);
  const leadingWhitespace = selectedText.match(/^\s*/)?.[0] ?? '';
  const trailingWhitespace = selectedText.match(/\s*$/)?.[0] ?? '';
  const literal = selectedText.trim();
  const converted = formatIntegerLiteral(literal, target);
  if (!converted) {
    vscode.window.showErrorMessage('The selected text is not a supported decimal, hexadecimal (0x...) or binary (0b...) integer literal.');
    return;
  }
  await editor.edit((builder) => builder.replace(editor.selection, `${leadingWhitespace}${converted}${trailingWhitespace}`));
}

function formatIntegerLiteral(literal: string, target: IntegerLiteralTarget): string | undefined {
  const match = literal.match(/^([+-]?)(0[xX][0-9a-fA-F]+|0[bB][01]+|[0-9]+)([uUlL]*)$/);
  if (!match) {
    return undefined;
  }
  const [, sign, digits, suffix] = match;
  const unsignedDigits = digits.replace(/^0[xX]/, '').replace(/^0[bB]/, '');
  const base = /^0[xX]/.test(digits) ? 16 : /^0[bB]/.test(digits) ? 2 : 10;
  let value: bigint;
  try {
    value = BigInt(base === 16 ? `0x${unsignedDigits}` : base === 2 ? `0b${unsignedDigits}` : unsignedDigits);
  } catch {
    return undefined;
  }
  const body = target === 'hexadecimal'
    ? `0x${value.toString(16).toUpperCase()}`
    : target === 'binary'
      ? `0b${value.toString(2)}`
      : value.toString(10);
  return `${sign}${body}${suffix}`;
}

export function deactivate(): void {
  // Resources are disposed through context.subscriptions.
}
