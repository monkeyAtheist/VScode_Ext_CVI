const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const extension = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
const service = fs.readFileSync(path.join(root, 'src', 'services', 'cviNativeCommandService.ts'), 'utf8');
const view = fs.readFileSync(path.join(root, 'src', 'views', 'cviDebugView.ts'), 'utf8');
const outExtension = fs.readFileSync(path.join(root, 'out', 'extension.js'), 'utf8');
const outView = fs.readFileSync(path.join(root, 'out', 'views', 'cviDebugView.js'), 'utf8');
const vsix = '/mnt/data/labwindows-cvi-project-manager-0.6.22.vsix';

assert.strictEqual(pkg.version, '0.6.22');
assert(pkg.activationEvents.includes('onView:labwindowsCvi.debugControls'));
assert(pkg.activationEvents.includes('onCommand:labwindowsCvi.refreshNativeDebugView'));
assert(pkg.contributes.views.labwindowsCvi.some((entry) => entry.id === 'labwindowsCvi.debugControls' && entry.name === 'CVI Debug'));
assert(pkg.contributes.commands.some((entry) => entry.command === 'labwindowsCvi.refreshNativeDebugView'));
assert(pkg.contributes.menus['view/title'].some((entry) => entry.command === 'labwindowsCvi.refreshNativeDebugView' && entry.when === 'view == labwindowsCvi.debugControls'));

for (const token of [
  "import { CviDebugView } from './views/cviDebugView'",
  "registerTreeDataProvider('labwindowsCvi.debugControls', debugView)",
  "register('labwindowsCvi.refreshNativeDebugView', () => nativeCommands.refreshDebugSnapshot())",
  'nativeCommands.onDidChange(() => updateStatusBar())',
  'CVI:${nativeStateText}',
  "? 'run'",
  "? 'pause'",
  "? 'idle'",
  ": 'off'"
]) assert(extension.includes(token), `extension token missing: ${token}`);

for (const token of [
  'export interface CviNativeDebugSnapshot',
  'serverAvailable?: boolean',
  'readonly onDidChange = this.changeEmitter.event',
  'getDebugSnapshot(): CviNativeDebugSnapshot',
  'refreshDebugSnapshot(): Promise<void>',
  "private markAction(command: string, result: string)",
  'this.changeEmitter.fire()',
  "this.setCachedExecution('running')",
  "this.setCachedExecution(nextState)"
]) assert(service.includes(token), `service token missing: ${token}`);

for (const token of [
  'class CviDebugView',
  'implements vscode.TreeDataProvider<CviDebugNode>',
  "info('Native bridge'",
  "info('Persistent session'",
  "info('Execution'",
  "info('Project'",
  "info('Linked'",
  "info('Transport'",
  "info('State source'",
  "info('Last command'",
  "info('Last result'",
  "action('Build native project'",
  "action('Run in native debugger'",
  "action('Pause native execution'",
  "action('Continue native execution'",
  "action('Stop native execution'",
  "action('Refresh native state'",
  "action('Diagnose native bridge'"
]) assert(view.includes(token), `view token missing: ${token}`);

assert(!view.includes('Webview'));
assert(outExtension.includes("registerTreeDataProvider('labwindowsCvi.debugControls', debugView)"));
assert(outView.includes('class CviDebugView'));

const list = cp.execFileSync('unzip', ['-l', vsix], { encoding: 'utf8' });
for (const entry of [
  'extension/out/views/cviDebugView.js',
  'extension/out/services/cviNativeCommandService.js',
  'extension/out/extension.js',
  'extension/package.json'
]) assert(list.includes(entry), `missing VSIX entry: ${entry}`);

const result = {
  version: pkg.version,
  nativeDebugTreeView: true,
  noDashboardWebview: true,
  dynamicStatusBar: ['CVI:off', 'CVI:idle', 'CVI:run', 'CVI:pause'],
  dashboardRows: ['bridge', 'session', 'execution', 'project', 'linked', 'transport', 'stateSource', 'lastCommand', 'lastResult'],
  dashboardActions: ['build', 'run', 'pause', 'continue', 'stop', 'refresh', 'diagnose'],
  nativeCommandChangeEvents: true,
  packagedCompiledDashboard: true
};
fs.writeFileSync(path.join(root, 'NATIVE_DEBUG_DASHBOARD_0.6.22_VALIDATION.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
