'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

process.env.NODE_PATH = path.join(__dirname, '..', 'test-mocks');
Module._initPaths();
const vscode = require('vscode');
vscode.RelativePattern = class RelativePattern { constructor(base, pattern){ this.base=base; this.pattern=pattern; } };

// Upgrade the minimal historical mock with lifecycle primitives used by v0.7.38.
const folderListeners = new Set();
vscode.workspace.onDidChangeWorkspaceFolders = (listener) => { folderListeners.add(listener); return { dispose(){ folderListeners.delete(listener); } }; };
vscode.workspace.createFileSystemWatcher = () => ({
  onDidChange(){ return { dispose(){} }; },
  onDidCreate(){ return { dispose(){} }; },
  onDidDelete(){ return { dispose(){} }; },
  dispose(){}
});

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));
const ext = read('src/extension.ts');
const wsSource = read('src/services/cviWorkspaceService.ts');
const cppSource = read('src/services/cviCppToolsService.ts');
const nativeSource = read('src/services/cviNativeCommandService.ts');
const buildSource = read('src/services/cviBuildService.ts');
const settingsSource = read('src/services/cviProjectSettingsService.ts');
const treeSource = read('src/providers/cviTreeProvider.ts');
const symbolsSource = read('src/providers/cviFileSymbolsProvider.ts');
const panelSource = read('src/views/buildSettingsPanel.ts');
const homeSource = read('src/views/homePanel.ts');
const librarySource = read('src/jcLibEmbedded.ts');

let passed=0, failed=0;
async function test(name, fn){
  try { await fn(); passed++; console.log('PASS '+name); }
  catch(e){ failed++; console.error('FAIL '+name+': '+(e.stack||e)); }
}

(async()=>{
  await test('package version includes v0.7.38 lifecycle fixes',()=>assert(/^0\.7\.(?:3[8-9]|[4-9]\d)$/.test(pkg.version)));
  await test('Close Workspace command is contributed and registered',()=>{
    assert(pkg.contributes.commands.some(c=>c.command==='labwindowsCvi.closeWorkspace'));
    assert(ext.includes("register('labwindowsCvi.closeWorkspace', () => workspaces.closeWorkspace())"));
  });
  await test('Close Workspace is exposed from workspace context and Home panel',()=>{
    assert(pkg.contributes.menus['view/item/context'].some(x=>x.command==='labwindowsCvi.closeWorkspace' && String(x.when||'').includes('cviWorkspace')));
    assert(homeSource.includes('data-command="labwindowsCvi.closeWorkspace"'));
  });
  await test('workspace service tracks disposal state and watcher generation',()=>{
    assert(wsSource.includes('private nativeWatcherGeneration = 0'));
    assert(wsSource.includes('private disposed = false'));
  });
  await test('workspace folder changes are reconciled instead of autoLoad-only',()=>assert(wsSource.includes('handleWorkspaceFoldersChanged(event)')));
  await test('removing owning VS Code folder unloads current CVI workspace',()=>assert(wsSource.includes("the owning VS Code workspace folder was removed")));
  await test('missing native workspace/project unloads stale in-memory state',()=>assert(wsSource.includes('native workspace/project disappeared from disk')));
  await test('unload disposes native watchers and clears pending refresh timer',()=>{
    const pos=wsSource.indexOf('private async unloadCurrentWorkspace'); const tail=wsSource.slice(pos,pos+1800);
    assert(tail.includes('clearTimeout(this.nativeRefreshTimer)'));
    assert(tail.includes('this.nativeFileWatchers.splice(0)'));
  });
  await test('watcher callbacks carry a generation token',()=>{
    assert(wsSource.includes('scheduleNativeFileRefresh(filePath, generation)'));
    assert(wsSource.includes('generation !== this.nativeWatcherGeneration'));
  });
  await test('watcher reconfiguration cancels an older refresh timer',()=>{
    const pos=wsSource.indexOf('private configureNativeFileWatchers'); const tail=wsSource.slice(pos,pos+1800);
    assert(tail.includes('this.nativeWatcherGeneration += 1'));
    assert(tail.includes('clearTimeout(this.nativeRefreshTimer)'));
  });
  await test('tree provider owns and disposes its workspace subscription',()=>{
    assert(treeSource.includes('vscode.Disposable'));
    assert(treeSource.includes('this.disposables.push(this.workspaces.onDidChange'));
    assert(treeSource.includes('this.changeEmitter.dispose()'));
  });
  await test('file symbols provider disposes its EventEmitter',()=>{
    assert(symbolsSource.includes('vscode.Disposable'));
    assert(symbolsSource.includes('this.changeEmitter.dispose()'));
  });
  await test('Build Settings follows workspace changes',()=>assert(panelSource.includes('handleWorkspaceChanged()')));
  await test('Build Settings closes when its project leaves current workspace',()=>assert(panelSource.includes('if (!current?.exists)')));
  await test('Build Settings save revalidates project membership before writing',()=>assert(panelSource.includes('no longer part of the active workspace')));
  await test('IntelliSense sync uses an epoch to cancel stale queued writes',()=>{
    assert(cppSource.includes('private syncEpoch = 0'));
    assert(cppSource.includes('epoch !== this.syncEpoch'));
    assert(cppSource.includes('Skipped stale IntelliSense synchronization'));
  });
  await test('IntelliSense dispose invalidates outstanding synchronization',()=>{
    const pos=cppSource.indexOf('dispose(): void'); const tail=cppSource.slice(pos,pos+500);
    assert(tail.includes('this.disposed = true'));
    assert(tail.includes('this.syncEpoch += 1'));
  });
  await test('native debugger subscribes to CVI workspace lifecycle',()=>assert(nativeSource.includes('this.workspaces.onDidChange(() => this.handleWorkspaceContextChanged())')));
  await test('idle native binding is released on context change',()=>assert(nativeSource.includes("this.releaseNativeBinding('VS Code workspace/project/build configuration changed')")));
  await test('running native binding is retained only for control actions',()=>assert(nativeSource.includes('binding is retained only for Pause/Continue/Stop')));
  await test('native DDE shutdown timers are tracked and cleared on dispose',()=>{
    assert(nativeSource.includes('ddeSessionKillTimers'));
    assert(nativeSource.includes("this.closeDdeSession('extension disposed', true)"));
  });
  await test('build service is disposable and tracks compiler processes',()=>{
    assert(buildSource.includes('CviBuildService implements vscode.Disposable'));
    assert(buildSource.includes('activeCompilerChildren'));
    assert(buildSource.includes('activeLogTimers'));
  });
  await test('build dispose kills compiler children and clears log polling',()=>{
    const pos=buildSource.indexOf('dispose(): void'); const tail=buildSource.slice(pos,pos+900);
    assert(tail.includes('clearInterval(timer)'));
    assert(tail.includes('child.kill()'));
  });
  await test('project build-step service is disposable and tracks shell children',()=>{
    assert(settingsSource.includes('CviProjectSettingsService implements vscode.Disposable'));
    assert(settingsSource.includes('activeShellChildren'));
    assert(settingsSource.includes('child.kill()'));
  });
  await test('extension lifecycle subscriptions include newly disposable services/providers',()=>{
    for (const token of ['builds,','projectSettings,','treeProvider,','fileSymbolsProvider,']) assert(ext.includes(token),token);
  });

  await test('embedded library tree provider disposes its EventEmitter',()=>{
    assert(librarySource.includes('class CviTreeProvider implements vscode.TreeDataProvider<CviItem>, vscode.Disposable'));
    assert(librarySource.includes('this._onDidChangeTreeData.dispose()'));
  });
  await test('embedded library Webviews are disposed with extension context',()=>{
    assert(librarySource.includes('choicePickerPanel?.dispose()'));
    assert(librarySource.includes('detailsPanel?.dispose()'));
    assert(librarySource.includes('for (const panel of [...packEditorPanels.values()]) panel.dispose()'));
  });
  await test('embedded library render timers are tracked and cancelled',()=>{
    assert(librarySource.includes('const libraryTimers = new Set<ReturnType<typeof setTimeout>>()'));
    assert(librarySource.includes('scheduleLibraryTimer'));
    assert(librarySource.includes('for (const timer of libraryTimers) clearTimeout(timer)'));
  });

  // Runtime check against the compiled workspace service: deleted standalone project must not remain loaded.
  const { CviParser } = require('../out/model/cviParser.js');
  const { CviWorkspaceService } = require('../out/services/cviWorkspaceService.js');
  const parser = new CviParser();
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'cvi0738-life-'));
  const created=parser.createWorkspaceAndProject(temp,'Life','App','Executable',undefined,2000);
  const memory=new Map();
  const context={workspaceState:{get(k){return memory.get(k);},async update(k,v){if(v===undefined)memory.delete(k);else memory.set(k,v);}}};
  const output={lines:[],appendLine(v=''){this.lines.push(String(v));}};
  const svc=new CviWorkspaceService(context,parser,{}, {}, output);
  await svc.load(created.projectPath);
  await test('runtime: explicit close unloads workspace and forgets persisted path', async()=>{
    assert(svc.currentWorkspace);
    await svc.closeWorkspace();
    assert.strictEqual(svc.currentWorkspace,undefined);
    assert.strictEqual(memory.get('labwindowsCvi.lastWorkspace'),undefined);
  });
  await svc.load(created.projectPath);
  await test('runtime: deleting loaded standalone project removes stale workspace state on refresh', async()=>{
    fs.unlinkSync(created.projectPath);
    svc.refresh();
    await new Promise(r=>setTimeout(r,0));
    assert.strictEqual(svc.currentWorkspace,undefined);
  });
  svc.dispose();

  console.log(`RESULT ${passed} passed, ${failed} failed`);
  if(failed) process.exitCode=1;
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
