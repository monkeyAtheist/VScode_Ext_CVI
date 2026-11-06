const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

process.env.NODE_PATH = path.join(__dirname, '..', 'test-mocks');
Module._initPaths();

const vscode = require('vscode');
const { CviParser } = require('../out/model/cviParser');
const { CviBuildService } = require('../out/services/cviBuildService');

const samples = '/mnt/data/ws_example/Exemple Workspace_projet';
const parser = new CviParser();
let passed = 0;
function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => { passed += 1; console.log(`PASS ${name}`); });
    }
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}: ${error.stack || error}`);
    process.exitCode = 1;
  }
}

function outputChannel() {
  return { lines: [], appendLine(v=''){ this.lines.push(String(v)); }, clear(){ this.lines=[]; }, show(){} };
}
function diagnostics() { return { clear(){}, set(){} }; }
function serviceFor(workspaces, parserOverride = parser) {
  return new CviBuildService(
    parserOverride,
    workspaces,
    { getActiveInstallation(){ return undefined; }, async selectInstallation(){ return undefined; } },
    { getSettings(){ return { run: { arguments:'', workingDirectory:'', environmentOptions:'', externalProcessPath:'' } }; } },
    { async synchronize(){ return false; } },
    outputChannel(), outputChannel(), diagnostics()
  );
}

(async () => {
  await test('native workspace build configuration parsed per project', () => {
    const ws = parser.parseWorkspace(path.join(samples, 'IHM_WorkSpace.cws'));
    const expected = ['debug','debug','debug','release','debug','release','debug','release'];
    assert.deepStrictEqual(ws.projects.map(p => p.buildMode), expected);
    assert.strictEqual(ws.activeProjectIndex, 5);
  });

  await test('changing one native build configuration preserves other project modes and Opened Files UI state', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvi0731-mode-'));
    const source = path.join(samples, 'IHM_WorkSpace.cws');
    const target = path.join(dir, 'IHM_WorkSpace.cws');
    fs.copyFileSync(source, target);
    const before = fs.readFileSync(target, 'utf8').match(/Number of Opened Files = (\d+)/)[1];
    parser.setWorkspaceProjectBuildMode(target, 1, 'release64');
    assert.strictEqual(parser.getWorkspaceProjectBuildMode(target, 1), 'release64');
    assert.strictEqual(parser.getWorkspaceProjectBuildMode(target, 4), 'release');
    const after = fs.readFileSync(target, 'utf8').match(/Number of Opened Files = (\d+)/)[1];
    assert.strictEqual(after, before);
  });

  await test('real CVI workspace is not falsely rejected because File sections exceed Number of Opened Files', () => {
    const issues = parser.inspectWorkspaceCompatibility(path.join(samples, 'IHM_WorkSpace.cws'));
    assert(!issues.some(issue => issue.includes('Number of Opened Files=5') && issue.includes('[File NNNN]')));
  });

  await test('target path follows native mode-specific relative paths', () => {
    const gr = path.join(samples, 'GR_IHM.prj');
    const edit = path.join(samples, 'fileEdition_main.prj');
    assert.strictEqual(path.basename(parser.getTargetPath(gr, 'debug')), 'GR_IHM.exe');
    assert.strictEqual(path.dirname(parser.getTargetPath(gr, 'debug')), '/mnt/data');
    assert.strictEqual(path.dirname(parser.getTargetPath(gr, 'debug64')), samples);
    assert.strictEqual(path.basename(parser.getTargetPath(edit, 'debug')), 'EditDB.exe');
    assert.strictEqual(path.basename(parser.getTargetPath(edit, 'release64')), 'fileEdition_main.exe');
  });

  await test('build service resolves each project native mode instead of forcing active/global mode', () => {
    const ref1 = { index: 1, name:'A', absolutePath:'C:\\P\\A.prj', relativePath:'A.prj', exists:true };
    const ref2 = { index: 2, name:'B', absolutePath:'C:\\P\\B.prj', relativePath:'B.prj', exists:true };
    const workspaces = {
      activeProjectRef: ref1,
      getProjectBuildMode(ref){ return ref.index === 1 ? 'debug' : 'release64'; }
    };
    const svc = serviceFor(workspaces);
    assert.strictEqual(svc.buildMode, 'debug');
    assert.strictEqual(svc.resolveBuildMode(ref2), 'release64');
    assert.deepStrictEqual(svc.commonCompilerArguments(false, 'release64'), ['-release64']);
  });

  await test('relative Program Name / Working Directory are resolved from the project directory', () => {
    const svc = serviceFor({ activeProjectRef: undefined, getProjectBuildMode(){ return undefined; } });
    assert.strictEqual(svc.resolveRuntimeReference('bin\\host.exe', 'C:\\Projects\\App'), 'C:\\Projects\\App\\bin\\host.exe');
    assert.strictEqual(svc.resolveRuntimeReference('run', 'C:\\Projects\\App'), 'C:\\Projects\\App\\run');
    assert.strictEqual(svc.resolveRuntimeReference('D:\\Tools\\host.exe', 'C:\\Projects\\App'), 'D:\\Tools\\host.exe');
  });

  await test('native debug converts Release64 to Debug64 and updates native project mode', async () => {
    const ref = { index: 3, name:'App', absolutePath:'C:\\P\\App.prj', relativePath:'App.prj', exists:true };
    let mode = 'release64';
    const workspaces = {
      activeProjectRef: ref,
      currentWorkspace: { path:'C:\\P\\App.cws' },
      getProjectBuildMode(){ return mode; },
      setProjectBuildMode(_ref, next){ mode = next; }
    };
    const svc = serviceFor(workspaces);
    vscode.__state.warningResponse = 'Switch to debug';
    assert.strictEqual(await svc.ensureDebugBuildMode(ref), true);
    assert.strictEqual(mode, 'debug64');
  });

  await test('Release clean removes target only and preserves debug symbol databases', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvi0731-clean-release-'));
    const target = path.join(dir, 'App.exe');
    const cdb = path.join(dir, 'App.cdb');
    const pdb = path.join(dir, 'App.pdb');
    [target,cdb,pdb].forEach(f => fs.writeFileSync(f, 'x'));
    const ref = { index:1, name:'App', absolutePath:path.join(dir,'App.prj'), relativePath:'App.prj', exists:true };
    const workspaces = { activeProjectRef:ref, getProjectBuildMode(){return 'release';}, getProject(){return {targetType:'Executable'};} };
    const p = { getTargetPath(){ return target; } };
    const svc = serviceFor(workspaces, p);
    await svc.clean(ref);
    assert.strictEqual(fs.existsSync(target), false);
    assert.strictEqual(fs.existsSync(cdb), true);
    assert.strictEqual(fs.existsSync(pdb), true);
  });

  await test('Debug clean removes target and debug symbol databases', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvi0731-clean-debug-'));
    const target = path.join(dir, 'App.exe');
    const cdb = path.join(dir, 'App.cdb');
    const pdb = path.join(dir, 'App.pdb');
    [target,cdb,pdb].forEach(f => fs.writeFileSync(f, 'x'));
    const ref = { index:1, name:'App', absolutePath:path.join(dir,'App.prj'), relativePath:'App.prj', exists:true };
    const workspaces = { activeProjectRef:ref, getProjectBuildMode(){return 'debug';}, getProject(){return {targetType:'Executable'};} };
    const p = { getTargetPath(){ return target; } };
    const svc = serviceFor(workspaces, p);
    await svc.clean(ref);
    assert.strictEqual(fs.existsSync(target), false);
    assert.strictEqual(fs.existsSync(cdb), false);
    assert.strictEqual(fs.existsSync(pdb), false);
  });

  await test('native debug command performs debug-mode guard before preflight build', () => {
    const extension = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
    const guard = extension.indexOf('await builds.ensureDebugBuildMode()');
    const preflight = extension.indexOf("get<boolean>('buildBeforeNativeDebug', true)");
    assert(guard >= 0 && preflight > guard);
  });

  if (!process.exitCode) console.log(`RESULT ${passed} passed, 0 failed`);
})();
