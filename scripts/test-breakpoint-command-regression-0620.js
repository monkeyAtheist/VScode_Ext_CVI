const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const extension = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
const buildService = fs.readFileSync(path.join(root, 'src', 'services', 'cviBuildService.ts'), 'utf8');
const syncService = fs.readFileSync(path.join(root, 'src', 'services', 'cviBreakpointSyncService.ts'), 'utf8');
const parser = fs.readFileSync(path.join(root, 'src', 'model', 'cviParser.ts'), 'utf8');

assert.strictEqual(pkg.version, '0.6.20');
for (const command of [
  'labwindowsCvi.synchronizeBreakpoints',
  'labwindowsCvi.clearSynchronizedBreakpoints',
  'labwindowsCvi.diagnoseBreakpointBridge'
]) {
  assert(pkg.contributes.commands.some((entry) => entry.command === command), `missing contribution: ${command}`);
  assert(extension.includes(`register('${command}'`), `missing registration: ${command}`);
}
assert(pkg.contributes.configuration.properties['labwindowsCvi.synchronizeBreakpointsBeforeNativeDebug'].default === true);
assert(buildService.includes("get<boolean>('synchronizeBreakpointsBeforeNativeDebug', true)"));
assert(buildService.includes('await this.breakpoints.synchronize(ref, false)'));
assert(syncService.includes('breakpoint instanceof vscode.SourceBreakpoint'));
assert(syncService.includes('breakpoint.condition || breakpoint.hitCondition || breakpoint.logMessage'));
assert(parser.includes('synchronizeWorkspaceBreakpoints('));
assert(parser.includes("section.deleteMatching(/^\\s*Breakpoint\\s+\\d{4}\\s*=/i)"));
assert(parser.includes("header.set('Number of Opened Files'"));
assert(parser.includes("Tracepoint"));

const workspaceMenu = pkg.contributes.menus['view/item/context'];
for (const target of ['viewItem == cviWorkspace', 'viewItem == cviProject']) {
  assert(workspaceMenu.some((entry) => entry.command === 'labwindowsCvi.synchronizeBreakpoints' && entry.when.includes(target)));
  assert(workspaceMenu.some((entry) => entry.command === 'labwindowsCvi.clearSynchronizedBreakpoints' && entry.when.includes(target)));
  assert(workspaceMenu.some((entry) => entry.command === 'labwindowsCvi.diagnoseBreakpointBridge' && entry.when.includes(target)));
}

console.log(JSON.stringify({
  version: pkg.version,
  commandContributions: 3,
  commandRegistrations: 3,
  workspaceAndProjectContextMenus: true,
  automaticSynchronizationBeforeNativeDebug: true,
  conservativeSkipOfUnsupportedBreakpoints: true,
  parserNativeSerializationHook: true
}, null, 2));
