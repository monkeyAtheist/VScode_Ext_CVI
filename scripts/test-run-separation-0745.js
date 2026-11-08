const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const extension = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
const build = fs.readFileSync(path.join(root, 'src', 'services', 'cviBuildService.ts'), 'utf8');
const home = fs.readFileSync(path.join(root, 'src', 'views', 'homePanel.ts'), 'utf8');
const quick = fs.readFileSync(path.join(root, 'src', 'views', 'quickActionsView.ts'), 'utf8');
const settings = fs.readFileSync(path.join(root, 'src', 'views', 'buildSettingsPanel.ts'), 'utf8');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}: ${e.stack || e}`); }
}

(async () => {
  await test('package version is 0.7.45', () => assert.strictEqual(pkg.version, '0.7.45'));
  await test('Run command title no longer claims to build', () => {
    const c = pkg.contributes.commands.find(x => x.command === 'labwindowsCvi.run');
    assert.ok(c); assert.strictEqual(c.title, 'LabWindows/CVI: Run Active Target');
  });
  await test('Build + Run has a dedicated command', () => {
    const c = pkg.contributes.commands.find(x => x.command === 'labwindowsCvi.buildAndRun');
    assert.ok(c); assert.match(c.title, /Build and Run Active Target/);
  });
  await test('extension Run command executes without build', () => assert.match(extension, /register\('labwindowsCvi\.run', \(\) => builds\.runWithoutBuild\(\)\)/));
  await test('extension Build + Run command keeps old behavior', () => assert.match(extension, /register\('labwindowsCvi\.buildAndRun', \(\) => builds\.buildAndRun\(\)\)/));
  await test('legacy runWithoutBuild alias remains registered', () => assert.match(extension, /register\('labwindowsCvi\.runWithoutBuild', \(\) => builds\.runWithoutBuild\(\)\)/));
  await test('build service run() delegates to runWithoutBuild()', () => assert.match(build, /async run\([\s\S]*?await this\.runWithoutBuild\(projectRef\);/));
  await test('project context execute retains Build + Run compatibility', () => assert.match(extension, /register\('labwindowsCvi\.executeProject',[\s\S]*?builds\.buildAndRun\(node\.ref\)/));
  await test('status bar Play tooltip describes run without build', () => assert.match(extension, /Run the active CVI target without building/));
  await test('Home exposes Run and Build + Run separately', () => {
    assert.match(home, /data-command="labwindowsCvi\.run">Run<\/button>/);
    assert.match(home, /data-command="labwindowsCvi\.buildAndRun">Build \+ run<\/button>/);
  });
  await test('Quick Actions exposes Run and Build & Run separately', () => {
    assert.match(quick, /action\('Run', 'labwindowsCvi\.run'/);
    assert.match(quick, /action\('Build & Run', 'labwindowsCvi\.buildAndRun'/);
  });
  await test('Project Settings exposes Run and Build + run separately', () => {
    assert.match(settings, /data-command="labwindowsCvi\.run">Run<\/button>/);
    assert.match(settings, /data-command="labwindowsCvi\.buildAndRun">Build \+ run<\/button>/);
  });
  await test('runWithoutBuild command remains contributed', () => assert.ok(pkg.contributes.commands.some(x => x.command === 'labwindowsCvi.runWithoutBuild')));
  await test('Build + Run command has an activation event', () => assert.ok(pkg.activationEvents.includes('onCommand:labwindowsCvi.buildAndRun')));
  console.log(`RESULT ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
