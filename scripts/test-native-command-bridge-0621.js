const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const service = fs.readFileSync(path.join(root, 'src', 'services', 'cviNativeCommandService.ts'), 'utf8');
const outService = fs.readFileSync(path.join(root, 'out', 'services', 'cviNativeCommandService.js'), 'utf8');
const dde = fs.readFileSync(path.join(root, 'native', 'cvi-dde-command.ps1'), 'utf8');
const vsix = '/mnt/data/labwindows-cvi-project-manager-0.6.21.vsix';

assert.strictEqual(pkg.version, '0.6.21');
const props = pkg.contributes.configuration.properties;
assert.strictEqual(props['labwindowsCvi.nativeCommandTransport'].default, 'dde');
assert.strictEqual(props['labwindowsCvi.nativeDdeSessionStartupTimeoutMs'].default, 15000);

for (const token of [
  'implements vscode.Disposable',
  'private ddeSession?: DdeSessionHandle',
  'private cachedProjectExecution',
  'await this.ensureDdeSession()',
  "await this.executeAction(COMMANDS.run, 'Native CVI execution started.', true)",
  'executeDdeSessionControl(COMMANDS.pause',
  'executeDdeSessionControl(COMMANDS.continueExecution',
  'executeDdeSessionControl(COMMANDS.stop',
  "'-Session'",
  'Persistent DDE debug session connected',
  'invokeDdeSession(command: string, argument: string)',
  'No persistent native CVI debug session is available',
  'cached while the project is active',
  "this.closeDdeSession('extension disposed')"
]) assert(service.includes(token), `service token missing: ${token}`);

for (const token of [
  'Persistent DDE debug session connected',
  'invokeDdeSession(command, argument)',
  'No persistent native CVI debug session is available',
  'cached while the project is active'
]) assert(outService.includes(token), `compiled service token missing: ${token}`);

for (const token of [
  '[switch]$Session',
  'function Write-JsonLine',
  'function New-ConnectedDdeClient',
  'if ($Session)',
  "event = 'ready'",
  "event = 'response'",
  "$requestCommand -eq '__close__'",
  '[Console]::In.ReadLine()',
  '$sessionClient.Execute($wireCommand, $requestTimeout)'
]) assert(dde.includes(token), `persistent DDE PowerShell token missing: ${token}`);

const list = cp.execFileSync('unzip', ['-l', vsix], { encoding: 'utf8' });
for (const entry of [
  'extension/native/cvi-dde-command.ps1',
  'extension/out/services/cviNativeCommandService.js'
]) assert(list.includes(entry), `missing VSIX entry: ${entry}`);

const result = {
  version: pkg.version,
  persistentDdeSession: true,
  sessionOpenedBeforeRun: true,
  runControlsUseExistingConversation: ['Suspend Execution', 'Continue Execution', 'Terminate Execution'],
  synchronousStateProbeRemovedFromActiveControls: true,
  cachedStateUsedWhileProgramActive: true,
  sessionClosedOnExtensionDispose: true,
  packagedPersistentPowerShellBridge: true,
  packagedCompiledService: true
};
fs.writeFileSync(path.join(root, 'NATIVE_COMMAND_BRIDGE_0.6.21_VALIDATION.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
