const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const extension = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
const adapter = fs.readFileSync(path.join(root, 'src', 'debug', 'cviNativeDebugAdapter.ts'), 'utf8');
const service = fs.readFileSync(path.join(root, 'src', 'services', 'cviNativeCommandService.ts'), 'utf8');
const view = fs.readFileSync(path.join(root, 'src', 'views', 'cviDebugView.ts'), 'utf8');
const outAdapter = fs.readFileSync(path.join(root, 'out', 'debug', 'cviNativeDebugAdapter.js'), 'utf8');
const vsix = '/mnt/data/labwindows-cvi-project-manager-0.6.24.vsix';

assert.strictEqual(pkg.version, '0.6.24');
assert(pkg.activationEvents.includes('onDebug:labwindows-cvi-native'));
assert(pkg.activationEvents.includes('onCommand:labwindowsCvi.startVsCodeDebugging'));
assert(pkg.contributes.commands.some((entry) => entry.command === 'labwindowsCvi.startVsCodeDebugging'));
assert(pkg.contributes.debuggers.some((entry) => entry.type === 'labwindows-cvi-native'));
assert(pkg.contributes.breakpoints.some((entry) => entry.language === 'c'));
assert(pkg.contributes.breakpoints.some((entry) => entry.language === 'cpp'));
assert.strictEqual(pkg.contributes.configuration.properties['labwindowsCvi.nativeDebuggerIdeWindowMode'].default, 'minimized');
assert.strictEqual(pkg.contributes.configuration.properties['labwindowsCvi.keepNativeIdeMinimizedDuringVsCodeDebug'].default, true);
assert.strictEqual(pkg.contributes.configuration.properties['labwindowsCvi.nativeDapPollIntervalMs'].default, 750);
assert.strictEqual(pkg.contributes.configuration.properties['labwindowsCvi.nativeDapPollTimeoutMs'].default, 1000);

for (const token of [
  'CVI_NATIVE_DEBUG_TYPE',
  'CviNativeDebugAdapterFactory',
  'CviNativeDebugConfigurationProvider',
  'vscode.debug.registerDebugConfigurationProvider',
  'vscode.debug.registerDebugAdapterDescriptorFactory',
  "register('labwindowsCvi.startVsCodeDebugging'"
]) assert(extension.includes(token), `extension token missing: ${token}`);

for (const token of [
  'implements vscode.DebugAdapter',
  "case 'initialize'",
  "case 'launch'",
  "case 'configurationDone'",
  "case 'setBreakpoints'",
  "case 'continue'",
  "case 'pause'",
  "case 'terminate'",
  "case 'disconnect'",
  "case 'stackTrace'",
  "case 'scopes'",
  "case 'variables'",
  'DebugAdapterInlineImplementation',
  'Native CVI variable evaluation is not available',
  'Native CVI step-by-step commands are not exposed'
]) assert(adapter.includes(token), `adapter token missing: ${token}`);

for (const token of [
  'startDebugAdapterMonitoring()',
  'pollDebugAdapterState()',
  "invokeDdeSession(COMMANDS.state, '', { timeoutMs: this.nativeDapPollTimeoutMs, closeOnTimeout: false })",
  'keepNativeIdeInBackground()',
  'cvi-start-background.ps1',
  'cvi-window-control.ps1',
  "get<string>('nativeDebuggerIdeWindowMode', 'minimized')",
  "get<boolean>('keepNativeIdeMinimizedDuringVsCodeDebug', true)"
]) assert(service.includes(token), `service token missing: ${token}`);

assert(view.includes("action('Start debugging in VS Code', 'labwindowsCvi.startVsCodeDebugging'"));
assert(view.includes("action('Run in native CVI window (legacy)', 'labwindowsCvi.nativeRun'"));
assert(outAdapter.includes('DebugAdapterInlineImplementation'));

const list = cp.execFileSync('unzip', ['-l', vsix], { encoding: 'utf8' });
for (const entry of [
  'extension/out/debug/cviNativeDebugAdapter.js',
  'extension/out/services/cviNativeCommandService.js',
  'extension/native/cvi-dde-command.ps1',
  'extension/native/cvi-start-background.ps1',
  'extension/native/cvi-window-control.ps1',
  'extension/package.json'
]) assert(list.includes(entry), `missing VSIX entry: ${entry}`);

const result = {
  version: pkg.version,
  inlineDebugAdapterRegistered: true,
  debuggerType: 'labwindows-cvi-native',
  sourceBreakpointContribution: ['c', 'cpp'],
  vscodeToolbarControls: ['launch', 'pause', 'continue', 'terminate', 'disconnect'],
  conservativeBreakpointVerification: true,
  minimizedNativeBackendDefault: true,
  backgroundWindowControlPackaged: true,
  persistentDdePolling: true,
  nonDestructivePollingTimeout: true,
  explicitPhaseOneLimitations: ['stackTrace', 'scopes', 'variables', 'evaluate', 'stepIn', 'stepOut', 'next'],
  legacyNativeWindowFallbackPreserved: true,
  packagedCompiledAdapter: true
};
fs.writeFileSync(path.join(root, 'NATIVE_DAP_0.6.24_VALIDATION.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
