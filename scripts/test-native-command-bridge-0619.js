const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const extension = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
const service = fs.readFileSync(path.join(root, 'src', 'services', 'cviNativeCommandService.ts'), 'utf8');
const outService = fs.readFileSync(path.join(root, 'out', 'services', 'cviNativeCommandService.js'), 'utf8');
const activeX = fs.readFileSync(path.join(root, 'native', 'cvi-activex-command.ps1'), 'utf8');
const dde = fs.readFileSync(path.join(root, 'native', 'cvi-dde-command.ps1'), 'utf8');
const discovery = fs.readFileSync(path.join(root, 'native', 'cvi-activex-discovery.ps1'), 'utf8');
const vsix = '/mnt/data/labwindows-cvi-project-manager-0.6.19.vsix';

assert.strictEqual(pkg.version, '0.6.19');
const commands = [
  'labwindowsCvi.chooseNativeDebugAction',
  'labwindowsCvi.nativeBuild',
  'labwindowsCvi.nativeRun',
  'labwindowsCvi.nativePause',
  'labwindowsCvi.nativeContinue',
  'labwindowsCvi.nativeStop',
  'labwindowsCvi.nativeState',
  'labwindowsCvi.diagnoseNativeCommandBridge'
];
const declared = new Set(pkg.contributes.commands.map((entry) => entry.command));
for (const command of commands) {
  assert(declared.has(command), `missing command ${command}`);
  assert(pkg.activationEvents.includes(`onCommand:${command}`), `missing activation event ${command}`);
  assert(extension.includes(`register('${command}'`), `missing registration ${command}`);
}

for (const token of [
  "'CVI.Application'", '[System.Runtime.InteropServices.Marshal]::GetActiveObject($progId)',
  'New-Object -ComObject $progId', '[switch]$CreateIfMissing', 'GetCVIState', 'BuildProject',
  'RunProject(0)', 'SuspendExecution', 'ContinueExecution', 'TerminateExecution(0)',
  "transport = 'activex'", "connectionMode = 'active-object'", "connectionMode = 'create-object'",
  'FinalReleaseComObject'
]) assert(activeX.includes(token), `ActiveX bridge token missing: ${token}`);

for (const token of [
  'DdeInitializeA', 'DdeInitializeW', "service = 'cvi'", "topic = 'system'", "item = 'status'",
  'CviDdeBridge.0.6.18.dll'
]) assert(dde.includes(token), `DDE fallback token missing: ${token}`);

for (const token of [
  '[Microsoft.Win32.RegistryView]::Registry64', '[Microsoft.Win32.RegistryView]::Registry32',
  'targeted ProgID scan', 'App Paths\\\\cvi.exe'
]) assert(discovery.includes(token), `ActiveX discovery token missing: ${token}`);

for (const token of [
  "path.join('native', 'cvi-activex-command.ps1')", 'invokeActiveX(command, argument, createActiveXIfMissing)',
  'invokeDde(command, argument)', 'fallbackFrom: activeX', 'nativeActiveXProcessTimeoutMs',
  "describePowerShellFailure('Native ActiveX bridge'", "describePowerShellFailure('Native DDE fallback bridge'",
  'ActiveX ProgID:', 'ActiveX attempt', 'DDE attempt'
]) {
  assert(service.includes(token), `service token missing: ${token}`);
  assert(outService.includes(token), `compiled service token missing: ${token}`);
}

assert.strictEqual(pkg.contributes.configuration.properties['labwindowsCvi.nativeActiveXProcessTimeoutMs'].default, 15000);
assert.strictEqual(pkg.contributes.configuration.properties['labwindowsCvi.nativeBridgeProcessTimeoutMs'].default, 90000);
assert.strictEqual(pkg.contributes.configuration.properties['labwindowsCvi.activeXDiscoveryTimeoutMs'].default, 10000);

const list = cp.execFileSync('unzip', ['-l', vsix], { encoding: 'utf8' });
assert(list.includes('extension/native/cvi-activex-command.ps1'));
assert(list.includes('extension/native/cvi-dde-command.ps1'));
assert(list.includes('extension/native/cvi-activex-discovery.ps1'));
assert(list.includes('extension/out/services/cviNativeCommandService.js'));

const result = {
  version: pkg.version,
  commandsDeclaredAndRegistered: commands.length,
  primaryTransport: 'ActiveX CVI.Application',
  activeXConnectionModes: ['active-object', 'create-object'],
  activeXMethods: ['GetCVIState', 'BuildProject', 'RunProject', 'SuspendExecution', 'ContinueExecution', 'TerminateExecution'],
  ddeCompatibilityFallback: { modes: ['ansi', 'unicode'], service: 'cvi', topic: 'system', item: 'status' },
  activeXHostTimeoutMs: 15000,
  ddeFallbackHostTimeoutMs: 90000,
  activeXRegistryDiscoveryTimeoutMs: 10000,
  packagedBridgeScripts: 3,
  packagedCompiledService: true
};
console.log(JSON.stringify(result, null, 2));
