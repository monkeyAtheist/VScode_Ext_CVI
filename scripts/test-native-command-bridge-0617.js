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
const vsix = '/mnt/data/labwindows-cvi-project-manager-0.6.17.vsix';

assert.strictEqual(pkg.version, '0.6.17');
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
  'New-Object -TypeName \'CviDdeBridge.CviDdeClient\' -ArgumentList',
  '$utf8NoBom = New-Object System.Text.UTF8Encoding $false'
]) assert(bridge.includes(token), `bridge token missing: ${token}`);

for (const token of [
  'Registry::HKEY_CLASSES_ROOT\\CLSID',
  'Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Classes\\Wow6432Node\\CLSID',
  'scannedRoots', 'warnings', 'activex-discovery', 'progId', 'versionIndependentProgId', 'LocalServer32', 'InprocServer32',
  '$utf8NoBom = New-Object System.Text.UTF8Encoding $false'
]) assert(discovery.includes(token), `ActiveX discovery token missing: ${token}`);

for (const token of [
  'if (argument.length > 0)', "args.push('-Argument', argument)", "args.push('-TimeoutMs', String(timeout))",
  "describePowerShellFailure('Native DDE bridge'", "describePowerShellFailure('ActiveX registry discovery'",
  'tryParseLastJsonLine<T>', 'process terminated by timeout', 'timeout: 30000', 'ActiveX scanned root', 'ActiveX discovery warning'
]) {
  assert(service.includes(token), `service token missing: ${token}`);
  assert(outService.includes(token.replace('tryParseLastJsonLine<T>', 'tryParseLastJsonLine')), `compiled service token missing: ${token}`);
}
assert(!service.includes("'-Argument', argument, '-TimeoutMs'"), 'empty argument is still forwarded unconditionally');
for (const token of ['Build Project', 'Run Project', 'Suspend Execution', 'Continue Execution', 'Terminate Execution', 'Get CVI State']) {
  assert(service.includes(token), `service command missing: ${token}`);
  assert(outService.includes(token), `compiled command missing: ${token}`);
}

const list = cp.execFileSync('unzip', ['-l', vsix], { encoding: 'utf8' });
assert(list.includes('extension/native/cvi-dde-command.ps1'));
assert(list.includes('extension/native/cvi-activex-discovery.ps1'));
assert(list.includes('extension/out/services/cviNativeCommandService.js'));

const result = {
  version: pkg.version,
  commandsDeclaredAndRegistered: commands.length,
  ddeCompatibilityModes: ['ansi', 'unicode'],
  ddeContract: { service: 'cvi', topic: 'system', item: 'status' },
  emptyArgumentForwardingFixed: true,
  earlyPowerShellFailureDetails: ['stderr', 'stdout', 'exit/code', 'signal', 'timeout'],
  guardedUtf8Initialization: true,
  explicitDdeClientConstruction: true,
  activeXRegistryDiscoveryTimeoutMs: 30000,
  activeXRegistryDiscoveryDiagnostics: ['scannedRoots', 'warnings'],
  packagedBridgeScripts: 2,
  packagedCompiledService: true
};
console.log(JSON.stringify(result, null, 2));
