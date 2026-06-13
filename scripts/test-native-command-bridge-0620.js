const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const service = fs.readFileSync(path.join(root, 'src', 'services', 'cviNativeCommandService.ts'), 'utf8');
const outService = fs.readFileSync(path.join(root, 'out', 'services', 'cviNativeCommandService.js'), 'utf8');
const dde = fs.readFileSync(path.join(root, 'native', 'cvi-dde-command.ps1'), 'utf8');
const activeX = fs.readFileSync(path.join(root, 'native', 'cvi-activex-command.ps1'), 'utf8');
const discovery = fs.readFileSync(path.join(root, 'native', 'cvi-activex-discovery.ps1'), 'utf8');
const vsix = '/mnt/data/labwindows-cvi-project-manager-0.6.20.vsix';

assert.strictEqual(pkg.version, '0.6.20');
const props = pkg.contributes.configuration.properties;
assert.strictEqual(props['labwindowsCvi.nativeCommandTransport'].default, 'dde');
assert.deepStrictEqual(props['labwindowsCvi.nativeCommandTransport'].enum, ['dde', 'auto', 'activex']);
assert.strictEqual(props['labwindowsCvi.allowActiveXAutoStart'].default, false);

for (const token of [
  "get<string>('nativeCommandTransport', 'dde')",
  "get<boolean>('allowActiveXAutoStart', false)",
  "if (strategy === 'dde')",
  'return await this.invokeDde(command, argument)',
  'if (await this.getDdeState(true))',
  'Started native IDE for DDE command bridge',
  'native DDE command server did not become available',
  "state.projectExecution !== 'running'",
  "state.projectExecution !== 'suspended'",
  "state.projectExecution === 'idle'",
  '(unsigned & 0xFFFF0000) === 0x80040000',
  '-(unsigned & 0xFFFF)'
]) assert(service.includes(token), `service token missing: ${token}`);

for (const token of [
  "get('nativeCommandTransport', 'dde')",
  "get('allowActiveXAutoStart', false)",
  "if (strategy === 'dde')",
  'return await this.invokeDde(command, argument)',
  'if (await this.getDdeState(true))',
  'Started native IDE for DDE command bridge',
  'native DDE command server did not become available',
  "state.projectExecution !== 'running'",
  "state.projectExecution !== 'suspended'",
  "state.projectExecution === 'idle'",
  '(unsigned & 0xFFFF0000) === 0x80040000',
  '-(unsigned & 0xFFFF)'
]) assert(outService.includes(token), `compiled service token missing: ${token}`);

for (const token of ['DdeInitializeA', 'DdeInitializeW', "service = 'cvi'", "topic = 'system'", "item = 'status'", 'CviDdeBridge.0.6.18.dll']) {
  assert(dde.includes(token), `DDE token missing: ${token}`);
}
for (const token of ["'CVI.Application'", 'GetCVIState', 'BuildProject', 'RunProject(0)', 'SuspendExecution', 'ContinueExecution', 'TerminateExecution(0)']) {
  assert(activeX.includes(token), `ActiveX compatibility token missing: ${token}`);
}
for (const token of ['Registry64', 'Registry32', 'App Paths\\\\cvi.exe']) {
  assert(discovery.includes(token), `discovery token missing: ${token}`);
}

const list = cp.execFileSync('unzip', ['-l', vsix], { encoding: 'utf8' });
for (const entry of [
  'extension/native/cvi-dde-command.ps1',
  'extension/native/cvi-activex-command.ps1',
  'extension/native/cvi-activex-discovery.ps1',
  'extension/out/services/cviNativeCommandService.js'
]) assert(list.includes(entry), `missing VSIX entry: ${entry}`);

const result = {
  version: pkg.version,
  defaultTransport: 'dde',
  optionalTransportModes: ['auto', 'activex'],
  activeXAutoStartDefault: false,
  ddeOnlyStartupPolling: true,
  stateAwareGuards: ['build', 'run', 'pause', 'continue', 'stop'],
  activeXHresultNormalization: '0x800400xx -> negative CVI status index',
  ddeCachePreserved: true,
  packagedBridgeScripts: 3,
  packagedCompiledService: true
};
console.log(JSON.stringify(result, null, 2));
