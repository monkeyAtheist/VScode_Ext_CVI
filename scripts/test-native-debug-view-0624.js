const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const view = fs.readFileSync(path.join(root, 'src', 'views', 'cviDebugView.ts'), 'utf8');
const outView = fs.readFileSync(path.join(root, 'out', 'views', 'cviDebugView.js'), 'utf8');
const vsix = '/mnt/data/labwindows-cvi-project-manager-0.6.24.vsix';

assert.strictEqual(pkg.version, '0.6.24');
for (const token of [
  "const activeSession = snapshot.sessionConnected && snapshot.execution !== 'idle'",
  "const buildAllowed = snapshot.execution !== 'running' && snapshot.execution !== 'suspended'",
  "const pauseAllowed = snapshot.sessionConnected && snapshot.execution === 'running'",
  'const continueAllowed = activeSession',
  'const stopAllowed = activeSession',
  "action('Start debugging in VS Code', 'labwindowsCvi.startVsCodeDebugging'",
  "action('Run in native CVI window (legacy)', 'labwindowsCvi.nativeRun'",
  "description: enabled ? undefined : 'Unavailable'",
  "icon: enabled ? icon : 'circle-slash'",
  "contextValue: enabled ? 'cviDebugCommand' : 'cviDebugCommandDisabled'",
  'command: enabled ? { command, title: label } : undefined'
]) assert(view.includes(token), `view token missing: ${token}`);
assert(!view.includes('Webview'));
assert(outView.includes('Start debugging in VS Code'));
assert(outView.includes('Run in native CVI window (legacy)'));
const list = cp.execFileSync('unzip', ['-l', vsix], { encoding: 'utf8' });
assert(list.includes('extension/out/views/cviDebugView.js'));
const result = {
  version: pkg.version,
  nativeDebugTreeView: true,
  primaryVsCodeDapAction: true,
  legacyNativeWindowFallback: true,
  contextualActionRows: true,
  visuallyDisabledUnavailableActions: true,
  noDashboardWebview: true,
  packagedCompiledDashboard: true
};
fs.writeFileSync(path.join(root, 'NATIVE_DEBUG_DASHBOARD_0.6.24_VALIDATION.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
