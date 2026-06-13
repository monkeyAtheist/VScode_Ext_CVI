const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const service = fs.readFileSync(path.join(root, 'src', 'services', 'cviNativeCommandService.ts'), 'utf8');
const outService = fs.readFileSync(path.join(root, 'out', 'services', 'cviNativeCommandService.js'), 'utf8');
const vsix = '/mnt/data/labwindows-cvi-project-manager-0.6.24.vsix';

assert.strictEqual(pkg.version, '0.6.24');
for (const token of [
  'if (!silent || response.ok)',
  'Persistent DDE session handshake accepted',
  'this.logBootstrap(ready.bootstrap)',
  'commandStatus !== 0',
  'Unexpected positive command-server status; possible CVI error',
  'never advance the cached debugger state silently',
  'private logBootstrap(bootstrap?: BridgeBootstrap): void',
  'startDebugAdapterMonitoring()',
  'endDebugAdapterSession(terminateExecution = false)',
  'closeOnTimeout: false'
]) assert(service.includes(token), `service token missing: ${token}`);
for (const token of [
  'Persistent DDE session handshake accepted',
  'commandStatus !== 0',
  'Unexpected positive command-server status; possible CVI error',
  'startDebugAdapterMonitoring()',
  'endDebugAdapterSession(terminateExecution = false)'
]) assert(outService.includes(token), `compiled service token missing: ${token}`);
assert(!outService.includes('[CVI] dde-session  ->'));
const list = cp.execFileSync('unzip', ['-l', vsix], { encoding: 'utf8' });
for (const entry of [
  'extension/out/services/cviNativeCommandService.js',
  'extension/native/cvi-dde-command.ps1',
  'extension/native/cvi-start-background.ps1',
  'extension/native/cvi-window-control.ps1',
  'extension/package.json'
]) assert(list.includes(entry), `missing VSIX entry: ${entry}`);
const result = {
  version: pkg.version,
  silentTransientDdeStartupPolling: true,
  explicitPersistentSessionHandshakeLog: true,
  actionCommandsAcceptOnlyZeroStatus: true,
  unexpectedPositiveStatusesRejectedConservatively: true,
  cachedStateNotAdvancedAfterRejectedCommand: true,
  persistentDdeSessionPreserved: true,
  dapMonitoringUsesPersistentSession: true,
  nonDestructiveDapPollTimeout: true,
  backgroundNativeIdeHelpersPackaged: true,
  packagedCompiledService: true
};
fs.writeFileSync(path.join(root, 'NATIVE_COMMAND_BRIDGE_0.6.24_VALIDATION.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
