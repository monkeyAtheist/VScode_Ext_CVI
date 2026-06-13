const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const extension = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
const service = fs.readFileSync(path.join(root, 'src', 'services', 'cviNativeCommandService.ts'), 'utf8');
const quickActions = fs.readFileSync(path.join(root, 'src', 'views', 'quickActionsView.ts'), 'utf8');
const bridge = fs.readFileSync(path.join(root, 'native', 'cvi-dde-command.ps1'), 'utf8');
const outService = fs.readFileSync(path.join(root, 'out', 'services', 'cviNativeCommandService.js'), 'utf8');
const vsix = '/mnt/data/labwindows-cvi-project-manager-0.6.15.vsix';

assert.strictEqual(pkg.version, '0.6.15');
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
const declared = new Set(pkg.contributes.commands.map(x => x.command));
for (const command of commands) {
  assert(declared.has(command), `missing command ${command}`);
  assert(pkg.activationEvents.includes(`onCommand:${command}`), `missing activation event ${command}`);
  assert(extension.includes(`register('${command}'`), `missing registration ${command}`);
}
for (const setting of [
  'labwindowsCvi.synchronizeBreakpointsBeforeNativeRun',
  'labwindowsCvi.nativeCommandTimeoutMs',
  'labwindowsCvi.nativeCommandStartupTimeoutMs',
  'labwindowsCvi.powershellExecutable'
]) assert(pkg.contributes.configuration.properties[setting], `missing setting ${setting}`);

for (const token of [
  '"cvi"', '"system"', '"status"', 'DdeInitializeW', 'DdeConnect', 'DdeClientTransaction',
]) assert(bridge.includes(token), `bridge token missing: ${token}`);
for (const token of ['Build Project', 'Run Project', 'Suspend Execution', 'Continue Execution', 'Terminate Execution', 'Get CVI State']) {
  assert(service.includes(token), `service command missing: ${token}`);
  assert(outService.includes(token), `compiled service command missing: ${token}`);
}
assert(service.includes('synchronizeBreakpointsBeforeNativeRun'));
assert(service.includes('this.breakpoints.synchronize(ref, false)'));
assert(service.includes('spawn(installation.ideExe'));
assert(quickActions.includes("'labwindowsCvi.nativeRun'"));
assert(quickActions.includes("'labwindowsCvi.nativePause'"));
assert(quickActions.includes("'labwindowsCvi.nativeContinue'"));
assert(quickActions.includes("'labwindowsCvi.nativeStop'"));

const list = cp.execFileSync('unzip', ['-l', vsix], { encoding: 'utf8' });
assert(list.includes('extension/native/cvi-dde-command.ps1'));
assert(list.includes('extension/out/services/cviNativeCommandService.js'));

const result = {
  version: pkg.version,
  commandsDeclared: commands.length,
  commandsRegistered: commands.length,
  activationEvents: commands.length,
  packagedBridgeScript: true,
  packagedCompiledService: true,
  ddeService: 'cvi',
  ddeTopic: 'system',
  ddeStatusItem: 'status',
  commands: {
    build: 'Build Project', run: 'Run Project', pause: 'Suspend Execution',
    continue: 'Continue Execution', stop: 'Terminate Execution', state: 'Get CVI State'
  },
  breakpointsSynchronizedBeforeNativeRun: true,
  automaticIdeStartup: true
};
console.log(JSON.stringify(result, null, 2));
