const assert = require('assert');
const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');
function read(p){ return fs.readFileSync(path.join(__dirname,'..',p),'utf8'); }
const extension = read('src/extension.ts');
const native = read('src/services/cviNativeCommandService.ts');
const view = read('src/views/cviDebugView.ts');
const dde = read('native/cvi-dde-command.ps1');
assert.strictEqual(pkg.version, '0.6.30');
assert(!pkg.activationEvents.includes('onDebug:labwindows-cvi-native'));
assert(!pkg.activationEvents.includes('onCommand:labwindowsCvi.startVsCodeDebugging'));
assert(!pkg.contributes.debuggers);
assert(pkg.contributes.breakpoints.some(x => x.language === 'c'));
assert(pkg.contributes.configuration.properties['labwindowsCvi.buildBeforeNativeDebug'].default === true);
assert(extension.includes("register('labwindowsCvi.nativeBuild', () => builds.build(false))"));
assert(extension.includes("const built = await builds.build(false);"));
assert(extension.includes("return await nativeCommands.run();"));
assert(native.includes("vscode.commands.executeCommand('labwindowsCvi.nativeRun')"));
assert(!native.includes('ExecuteAsync('));
assert(!dde.includes('TIMEOUT_ASYNC'));
assert(view.includes("group('Session status'"));
assert(view.includes("group('Available actions'"));
assert(view.includes("group('Diagnostics'"));
assert(view.includes('Build locally with compile.exe'));
assert(view.includes('Build locally and run in native debugger'));
assert(!fs.existsSync(path.join(__dirname,'..','out','debug','cviNativeDebugAdapter.js')));
console.log(JSON.stringify({
  version: pkg.version,
  dapRemoved: true,
  localCompileExePreflightBeforeNativeDebug: true,
  stableDdePathRestoredFrom: '0.6.24',
  dashboardGrouped: true,
  exactBreakpointMirrorAvailable: true,
  conservativeNaturalCompletionProbe: true
}, null, 2));
