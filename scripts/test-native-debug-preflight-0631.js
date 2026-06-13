const assert = require('assert');
const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');
function read(p){ return fs.readFileSync(path.join(__dirname,'..',p),'utf8'); }
const extension = read('src/extension.ts');
const native = read('src/services/cviNativeCommandService.ts');
const view = read('src/views/cviDebugView.ts');
const build = read('src/services/cviBuildService.ts');
const quick = read('src/views/quickActionsView.ts');
assert.strictEqual(pkg.version, '0.6.31');
assert(!pkg.activationEvents.includes('onDebug:labwindows-cvi-native'));
assert(!pkg.contributes.debuggers);
assert(pkg.contributes.breakpoints.some(x => x.language === 'c'));
assert.strictEqual(pkg.contributes.configuration.properties['labwindowsCvi.buildBeforeNativeDebug'].default, true);
assert.strictEqual(pkg.contributes.configuration.properties['labwindowsCvi.nativeCommandTimeoutMs'].default, 10000);
assert.strictEqual(pkg.contributes.configuration.properties['labwindowsCvi.nativeCommandStartupTimeoutMs'].default, 25000);
assert.strictEqual(pkg.contributes.configuration.properties['labwindowsCvi.nativeDdeSessionStartupTimeoutMs'].default, 30000);
assert.strictEqual(pkg.contributes.configuration.properties['labwindowsCvi.nativePostIdeStartDelayMs'].default, 2000);
assert(extension.includes('const runNativeDebug = async (): Promise<boolean>'));
assert(extension.includes("register('labwindowsCvi.nativeRun', async () => runNativeDebug())"));
assert(extension.includes("register('labwindowsCvi.debugInCvi', () => runNativeDebug())"));
assert(extension.includes("return await nativeCommands.run();"));
assert(native.includes('waitAfterNativeIdeStartup'));
assert(native.includes('Build & Run Debug'));
assert(view.includes("action('Build & Run Debug'"));
assert(!view.includes('Build locally with compile.exe'));
assert(view.includes("action('Continue', 'labwindowsCvi.nativeContinue'"));
assert(view.includes("action('Pause', 'labwindowsCvi.nativePause'"));
assert(view.includes("action('Stop', 'labwindowsCvi.nativeStop'"));
assert(build.includes("Build and run debug"));
assert(build.includes("vscode.commands.executeCommand('labwindowsCvi.nativeRun')"));
assert(quick.includes("Build & Run Debug"));
assert(!fs.existsSync(path.join(__dirname,'..','out','debug','cviNativeDebugAdapter.js')));
console.log(JSON.stringify({
  version: pkg.version,
  dapRemoved: true,
  localCompileExePreflightBeforeNativeDebug: true,
  nativeTimeoutDefaults: { commandMs: 10000, startupMs: 25000, sessionMs: 30000, postIdeDelayMs: 2000 },
  debugActionRenamed: 'Build & Run Debug',
  continueActionVisibleDuringNativeSession: true,
  standaloneBuildActionRemovedFromCviDebugView: true
}, null, 2));
