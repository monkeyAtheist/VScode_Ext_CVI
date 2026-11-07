'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
process.env.NODE_PATH = path.join(__dirname, '..', 'test-mocks');
Module._initPaths();

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const vscode = require('vscode');
const buildSource = fs.readFileSync(path.join(root, 'src', 'services', 'cviBuildService.ts'), 'utf8');
const extSource = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
const panelSource = fs.readFileSync(path.join(root, 'src', 'views', 'buildSettingsPanel.ts'), 'utf8');
const { CviBuildService } = require('../out/services/cviBuildService');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + ': ' + (e.stack || e)); }
}
function output(){ return {appendLine(){},append(){},clear(){},show(){}}; }
function diag(){ return {clear(){},set(){}}; }
function makeService(tmp, withPdb = true) {
  const projectPath = path.join(tmp, 'App.prj');
  const target = path.join(tmp, 'App.exe');
  const pdb = path.join(tmp, 'App.pdb');
  fs.writeFileSync(projectPath, '[Project Header]\n', 'utf8');
  fs.writeFileSync(target, 'exe');
  if (withPdb) fs.writeFileSync(pdb, 'pdb');
  const ref = { name: 'App.prj', absolutePath: projectPath, exists: true, index: 1, buildConfiguration: 'Debug' };
  const parser = {
    getTargetPath(){ return target; },
    getTargetPathForConfiguration(){ return target; },
    getNativeBuildConfiguration(){ return undefined; }
  };
  const workspaces = {
    activeProjectRef: ref,
    currentWorkspace: undefined,
    getProjectBuildMode(){ return 'debug'; },
    getProjectBuildConfiguration(){ return 'Debug'; },
    getProject(){ return { targetType: 'Executable', files: [] }; }
  };
  const settings = {
    externalBuild: { engine: 'msvc', debugInVsCode: true },
    run: { arguments: '--sample', workingDirectory: tmp, environmentOptions: '', externalProcessPath: '' }
  };
  const projectSettings = {
    getSettings(){ return settings; },
    parseArguments(){ return ['--sample']; }
  };
  return { service: new CviBuildService(parser, workspaces, {}, projectSettings, {}, output(), output(), diag()), ref, target, pdb };
}

(async()=>{
  await test('package version is 0.7.44',()=>assert.strictEqual(pkg.version,'0.7.44'));
  await test('manifest contributes Debug Existing Target command with debug icon',()=>{
    const cmd = pkg.contributes.commands.find(c=>c.command==='labwindowsCvi.debugWithoutBuild');
    assert(cmd); assert(/Debug Existing Target/.test(cmd.title)); assert.strictEqual(cmd.icon,'$(debug-alt)');
  });
  await test('workspace title toolbar contains direct debug-without-build button',()=>{
    const item = pkg.contributes.menus['view/title'].find(m=>m.command==='labwindowsCvi.debugWithoutBuild');
    assert(item); assert(item.when.includes('labwindowsCvi.workspaceExplorer'));
  });
  await test('extension registers engine-aware debug-without-build command',()=>{
    assert(extSource.includes("register('labwindowsCvi.debugWithoutBuild'"));
    assert(extSource.includes("builds.getBuildEngine(ref) === 'msvc'"));
    assert(extSource.includes('await runNativeDebug(false)'));
  });
  await test('native debugger helper accepts an explicit no-build override',()=>{
    assert(extSource.includes('runNativeDebug = async (buildOverride?: boolean)'));
    assert(extSource.includes('const shouldBuild = buildOverride ??'));
  });
  await test('run action picker exposes Debug existing target',()=>{
    assert(buildSource.includes("value: 'debugExisting'"));
    assert(buildSource.includes("executeCommand('labwindowsCvi.debugWithoutBuild')"));
  });
  await test('External Compiler visual page exposes Debug existing target',()=>{
    assert(panelSource.includes('Debug existing target (no build)'));
    assert(panelSource.includes('data-command="labwindowsCvi.debugWithoutBuild"'));
  });
  await test('external debug can launch existing EXE/PDB without calling build', async()=>{
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'cvi0744-'));
    const { service, ref, target } = makeService(tmp, true);
    vscode.__state.debugConfigs.length = 0;
    vscode.__state.debugStartResult = true;
    service.build = async()=>{ throw new Error('build must not be called'); };
    await service.debugExistingExternalTarget(ref);
    assert.strictEqual(vscode.__state.debugConfigs.length,1,'debug session not started');
    const debugConfig = vscode.__state.debugConfigs[0].config;
    assert.strictEqual(debugConfig.type,'cppvsdbg');
    assert.strictEqual(debugConfig.program,target);
    assert.deepStrictEqual(debugConfig.args,['--sample']);
    fs.rmSync(tmp,{recursive:true,force:true});
  });
  await test('debug existing target refuses missing PDB instead of rebuilding', async()=>{
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'cvi0744-'));
    const { service, ref } = makeService(tmp, false);
    vscode.__state.errors.length = 0;
    vscode.__state.debugConfigs.length = 0;
    service.build = async()=>{ throw new Error('build must not be called'); };
    await service.debugExistingExternalTarget(ref);
    assert.strictEqual(vscode.__state.debugConfigs.length,0);
    assert(vscode.__state.errors.some(e=>/PDB file is missing/.test(e)));
    fs.rmSync(tmp,{recursive:true,force:true});
  });
  await test('external debug existing implementation remains generic',()=>{
    assert(!/SeqApi|hReturn_|MCO_ACS/.test(buildSource+extSource+panelSource));
  });
  console.log(`RESULT ${passed} passed, ${failed} failed`); if(failed) process.exitCode=1;
})();
