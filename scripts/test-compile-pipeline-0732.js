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
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}: ${error.stack || error}`);
  }
}

function outputChannel() {
  return {
    lines: [],
    text: '',
    append(v=''){ this.text += String(v); },
    appendLine(v=''){ const value=String(v); this.lines.push(value); this.text += value + '\n'; },
    clear(){ this.lines=[]; this.text=''; },
    show(){}
  };
}
function diagnostics() { return { clear(){}, set(){} }; }
function basicSettings(configPath) {
  return {
    getConfigurationPath(){ return configPath; },
    getSettings(){ return { preBuildActions:[], customBuildActions:[], postBuildActions:[], run:{arguments:'',workingDirectory:'',environmentOptions:'',externalProcessPath:''} }; },
    hasNativeBuildActions(){ return false; },
    getBuildOrder(ref){ return [ref]; },
    async runActions(){ return true; },
    parseArguments(){ return []; },
    parseEnvironment(){ return process.env; }
  };
}
function serviceFor({ workspaces, parserOverride = parser, installation, settings, output, trace } = {}) {
  const out = output || outputChannel();
  const tr = trace || outputChannel();
  const projectSettings = settings || basicSettings(path.join(os.tmpdir(), 'cvi0732-test', '.vscode', 'labwindows-cvi-build.json'));
  const svc = new CviBuildService(
    parserOverride,
    workspaces || { activeProjectRef: undefined, getProjectBuildMode(){ return undefined; } },
    { getActiveInstallation(){ return installation; }, async selectInstallation(){ return installation; } },
    projectSettings,
    { async synchronize(){ return false; } },
    out, tr, diagnostics()
  );
  return { svc, out, trace: tr, projectSettings };
}
function makeCompiler(dir, body, name='fake-compile.sh') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}
function resetConfig() {
  vscode.__state.config = {};
  vscode.__state.errors = [];
  vscode.__state.infos = [];
  vscode.__state.warnings = [];
}

(async () => {
  await test('standard build mode emits exactly one native mode selector', () => {
    resetConfig();
    const { svc } = serviceFor();
    assert.deepStrictEqual(svc.commonCompilerArguments(false, 'release64'), ['-release64']);
    assert.deepStrictEqual(svc.commonCompilerArguments(true, 'debug'), ['-debug', '-rebuild']);
  });

  await test('named CVI configuration replaces mode selector instead of combining with it', () => {
    resetConfig();
    vscode.__state.config.customBuildConfiguration = 'Nightly Release';
    const { svc } = serviceFor();
    assert.deepStrictEqual(svc.commonCompilerArguments(false, 'release64'), ['-config=Nightly Release']);
    assert.deepStrictEqual(svc.commonCompilerArguments(true, 'debug'), ['-config=Nightly Release', '-rebuild']);
    assert.deepStrictEqual(svc.commonCompilerArguments(false, 'release64', false), ['-release64']);
  });

  await test('quoted named configuration is normalized once', () => {
    resetConfig();
    vscode.__state.config.customBuildConfiguration = '"QA Config"';
    const { svc } = serviceFor();
    assert.deepStrictEqual(svc.commonCompilerArguments(false, 'debug'), ['-config=QA Config']);
  });

  await test('extra compiler arguments cannot override extension-owned config/log switches', () => {
    resetConfig();
    vscode.__state.config.customBuildConfiguration = 'Nightly';
    vscode.__state.config.extraCompilerArguments = ['/DTEST=1', '-release', '-config=Other', '-log', 'other.log', '/I../sdk', '-rebuild'];
    const { svc } = serviceFor();
    assert.deepStrictEqual(svc.commonCompilerArguments(true, 'debug64'), ['-config=Nightly', '-rebuild', '/DTEST=1', '/I../sdk']);
  });

  await test('custom configuration applies only to requested project; dependency keeps native mode and fallback actions', async () => {
    resetConfig();
    vscode.__state.config.customBuildConfiguration = 'Nightly';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvi0732-order-'));
    const argsLog = path.join(dir, 'args.log');
    const compiler = makeCompiler(dir, `printf '%s\\n' "$*" >> "${argsLog}"\nexit 0`);
    const dep = { index:1, name:'Dep.prj', absolutePath:path.join(dir,'Dep.prj'), relativePath:'Dep.prj', exists:true };
    const root = { index:2, name:'Root.prj', absolutePath:path.join(dir,'Root.prj'), relativePath:'Root.prj', exists:true };
    fs.writeFileSync(dep.absolutePath, '[Project Header]\nTarget Type = "Static Library"\n');
    fs.writeFileSync(root.absolutePath, '[Project Header]\nTarget Type = "Executable"\n');
    const actionLabels = [];
    const settings = {
      ...basicSettings(path.join(dir,'.vscode','labwindows-cvi-build.json')),
      getBuildOrder(){ return [dep, root]; },
      getSettings(){ return { preBuildActions:['PRE'], customBuildActions:['CUSTOM'], postBuildActions:['POST'], run:{arguments:'',workingDirectory:'',environmentOptions:'',externalProcessPath:''} }; },
      hasNativeBuildActions(){ return false; },
      async runActions(_actions,label){ actionLabels.push(label); return true; }
    };
    const workspaces = {
      activeProjectRef: root,
      getProjectBuildMode(ref){ return ref === dep ? 'release64' : 'debug'; },
      getProject(){ return { targetType:'Executable', files:[] }; }
    };
    const fakeParser = { getTargetPath(refPath, mode){ return path.join(path.dirname(refPath), `${path.basename(refPath,'.prj')}-${mode}.exe`); } };
    const { svc } = serviceFor({ workspaces, parserOverride: fakeParser, installation:{compileExe:compiler}, settings });
    assert.strictEqual(await svc.build(false, root), true);
    const invocations = fs.readFileSync(argsLog,'utf8').trim().split(/\r?\n/);
    assert.strictEqual(invocations.length, 2);
    assert(invocations[0].includes(dep.absolutePath));
    assert(invocations[0].includes('-release64'));
    assert(!invocations[0].includes('-config=Nightly'));
    assert(invocations[1].includes(root.absolutePath));
    assert(invocations[1].includes('-config=Nightly'));
    assert(!invocations[1].includes(' -debug '));
    assert.strictEqual(actionLabels.filter(x => x.includes('Dep.prj')).length, 3);
    assert.strictEqual(actionLabels.filter(x => x.includes('Root.prj')).length, 0);
  });

  await test('relative compiler diagnostics resolve against project working directory', async () => {
    resetConfig();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvi0732-diag-'));
    fs.mkdirSync(path.join(dir,'src'));
    const compiler = makeCompiler(dir, `echo "src/main.c:12:3: error: undeclared identifier 'x'"\nexit 1`);
    const { svc, trace } = serviceFor({ settings:basicSettings(path.join(dir,'.vscode','labwindows-cvi-build.json')) });
    const result = await svc.runCviCompile(compiler, ['App.prj','-debug'], dir, 'Build App');
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.diagnostics[0].file, path.join(dir,'src','main.c'));
    assert.strictEqual(result.diagnostics[0].line, 12);
    assert.strictEqual(result.diagnostics[0].column, 3);
    assert(trace.text.includes('Capture summary:'));
  });

  await test('CVI build-step failure gets a specific diagnostic and hint', async () => {
    resetConfig();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvi0732-step-'));
    const compiler = makeCompiler(dir, `echo "CVI could not execute one or more of your build steps"\nexit 1`);
    const { svc } = serviceFor({ settings:basicSettings(path.join(dir,'.vscode','labwindows-cvi-build.json')) });
    const result = await svc.runCviCompile(compiler, ['App.prj','-debug'], dir, 'Build App');
    assert.strictEqual(result.success, false);
    assert(result.diagnostics.some(d => /build steps/i.test(d.message) && /pre-build|post-build|custom-build/i.test(d.hint || '')));
  });

  await test('unknown non-zero compiler exit creates a synthetic error instead of Errors=0', async () => {
    resetConfig();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvi0732-exit-'));
    const compiler = makeCompiler(dir, `echo "mysterious compiler failure"\nexit 7`);
    const { svc } = serviceFor({ settings:basicSettings(path.join(dir,'.vscode','labwindows-cvi-build.json')) });
    const result = await svc.runCviCompile(compiler, ['App.prj','-debug'], dir, 'Build App');
    assert.strictEqual(result.success, false);
    assert(result.diagnostics.some(d => d.severity === 'error' && /exited with code 7/.test(d.message)));
  });

  await test('build setting mutations use optimistic concurrency guard and preserve newer external save', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvi0732-race-'));
    const target = path.join(dir, 'GR_IHM.prj');
    fs.copyFileSync(path.join(samples,'GR_IHM.prj'), target);
    const originalRead = fs.readFileSync;
    const originalWrite = fs.writeFileSync;
    let reads = 0;
    fs.readFileSync = function(file, ...args) {
      if (path.resolve(String(file)) === path.resolve(target)) {
        reads += 1;
        if (reads === 2) {
          const current = originalRead.call(fs, target);
          originalWrite.call(fs, target, Buffer.concat([current, Buffer.from('\n; EXTERNAL_CVI_SAVE\n')]));
        }
      }
      return originalRead.call(fs, file, ...args);
    };
    try {
      assert.throws(() => parser.setProjectBuildActions(target, 'debug', { preBuildActions:['echo PRE'], customBuildActions:[], postBuildActions:[] }), /changed on disk/i);
    } finally {
      fs.readFileSync = originalRead;
      fs.writeFileSync = originalWrite;
    }
    assert(fs.readFileSync(target,'utf8').includes('EXTERNAL_CVI_SAVE'));
    assert(!fs.readFileSync(target,'utf8').includes('echo PRE'));
  });

  await test('all build-settings native writers pass a mutation snapshot to guarded writeText', () => {
    const source = fs.readFileSync(path.join(__dirname,'..','src','model','cviParser.ts'),'utf8');
    for (const method of ['setNativeTargetSettings','setWorkspaceRunOptions','setProjectBuildActions','setTargetType']) {
      const start = source.indexOf(`${method}(`);
      assert(start >= 0, method);
      const remainder = source.slice(start);
      const match = remainder.match(/^[\s\S]*?\n  }/);
      assert(match, `${method} body not found`);
      const body = match[0];
      assert(body.includes('readTextForMutation'), `${method} missing readTextForMutation`);
      assert(body.includes('snapshot.buffer'), `${method} missing expected buffer guard`);
    }
  });

  await test('Compile File explicitly bypasses named project configuration', () => {
    const source = fs.readFileSync(path.join(__dirname,'..','src','services','cviBuildService.ts'),'utf8');
    assert(source.includes("this.commonCompilerArguments(false, mode, '')"));
    assert(source.includes('is not applied to Compile File'));
  });

  console.log(`RESULT ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
