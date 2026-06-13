const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const extension = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
const service = fs.readFileSync(path.join(root, 'src', 'services', 'cviNativeCommandService.ts'), 'utf8');
const outService = fs.readFileSync(path.join(root, 'out', 'services', 'cviNativeCommandService.js'), 'utf8');
const bridge = fs.readFileSync(path.join(root, 'native', 'cvi-dde-command.ps1'), 'utf8');
const discovery = fs.readFileSync(path.join(root, 'native', 'cvi-activex-discovery.ps1'), 'utf8');
const vsix = '/mnt/data/labwindows-cvi-project-manager-0.6.18.vsix';

assert.strictEqual(pkg.version, '0.6.18');
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
  'DdeInitializeA', 'DdeInitializeW', 'DdeCreateStringHandleA', 'DdeCreateStringHandleW',
  'CP_WINANSI = 1004', 'CP_WINUNICODE = 1200', "foreach ($mode in @('Ansi', 'Unicode'))",
  "service = 'cvi'", "topic = 'system'", "item = 'status'", 'DMLERR_NO_CONV_ESTABLISHED',
  'CviDdeBridge.0.6.18.dll', '-OutputAssembly $assemblyPath', '-OutputType Library', '-PassThru',
  "Add-Type -LiteralPath $assemblyPath", 'loadedFromCache', 'compiled = $false', 'bootstrap = $bridgeBootstrap'
]) assert(bridge.includes(token), `bridge token missing: ${token}`);

for (const token of [
  '[Microsoft.Win32.RegistryKey]::OpenBaseKey', '[Microsoft.Win32.RegistryView]::Registry64',
  '[Microsoft.Win32.RegistryView]::Registry32', 'targeted ProgID scan', 'GetSubKeyNames()',
  'App Paths\\\\cvi.exe', 'scannedRoots', 'warnings', 'activex-discovery', 'registryView', 'kind'
]) assert(discovery.includes(token), `ActiveX discovery token missing: ${token}`);
assert(!discovery.includes("Get-ChildItem -LiteralPath $root"), 'slow recursive-ish PowerShell provider CLSID scan still present');

for (const token of [
  'if (argument.length > 0)', "args.push('-Argument', argument)", "args.push('-TimeoutMs', String(timeout))",
  "nativeBridgeProcessTimeoutMs", "activeXDiscoveryTimeoutMs", "Math.max(30000", "Math.max(3000",
  "describePowerShellFailure('Native DDE bridge'", "describePowerShellFailure('ActiveX registry discovery'",
  'DDE helper cache:', 'loaded from cache', 'compiled now', 'process terminated by timeout'
]) {
  assert(service.includes(token), `service token missing: ${token}`);
  assert(outService.includes(token), `compiled service token missing: ${token}`);
}
assert.strictEqual(pkg.contributes.configuration.properties['labwindowsCvi.nativeBridgeProcessTimeoutMs'].default, 90000);
assert.strictEqual(pkg.contributes.configuration.properties['labwindowsCvi.activeXDiscoveryTimeoutMs'].default, 10000);

const list = cp.execFileSync('unzip', ['-l', vsix], { encoding: 'utf8' });
assert(list.includes('extension/native/cvi-dde-command.ps1'));
assert(list.includes('extension/native/cvi-activex-discovery.ps1'));
assert(list.includes('extension/out/services/cviNativeCommandService.js'));

const result = {
  version: pkg.version,
  commandsDeclaredAndRegistered: commands.length,
  ddeCompatibilityModes: ['ansi', 'unicode'],
  ddeContract: { service: 'cvi', topic: 'system', item: 'status' },
  localCachedHelper: 'CviDdeBridge.0.6.18.dll',
  firstInvocationHostTimeoutMs: 90000,
  ddeTransactionTimeoutMs: pkg.contributes.configuration.properties['labwindowsCvi.nativeCommandTimeoutMs'].default,
  targetedActiveXDiscovery: true,
  activeXRegistryViews: ['Registry64', 'Registry32'],
  activeXRegistryDiscoveryTimeoutMs: 10000,
  packagedBridgeScripts: 2,
  packagedCompiledService: true
};
console.log(JSON.stringify(result, null, 2));
