const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { CviParser } = require('../out/model/cviParser');
const { IniDocument } = require('../out/model/iniDocument');

const parser = new CviParser();
const sourceRoot = '/mnt/data/CVI_TEST_EXTRACT/CVI_TEST';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvi0613-'));
const cws = path.join(temp, 'Testing.cws');
fs.copyFileSync(path.join(sourceRoot, 'Testing.cws'), cws);
for (const name of ['CVI_Project.prj', 'SecPrj.prj', 'dqdzdad.prj']) {
  fs.copyFileSync(path.join(sourceRoot, name), path.join(temp, name));
}

const before = parser.inspectWorkspaceCompatibility(cws);
assert(before.some((issue) => issue.includes('[Default Build Config 0002 Debug] is missing')));
assert(before.some((issue) => issue.includes('[Default Build Config 0003 Debug] is missing')));

parser.setWorkspaceRunOptions(cws, 3, 'debug', {
  arguments: '--from-vscode',
  workingDirectory: 'C:\\runtime\\third-project',
  environmentOptions: 'MODE=scaffold',
  externalProcessPath: 'C:\\tools\\third-runner.exe'
});
let doc = IniDocument.parse(fs.readFileSync(cws, 'utf8'));
assert(doc.getSection('Project Header 0003'));
for (const mode of ['Debug', 'Release', 'Debug64', 'Release64']) {
  assert(doc.getSection(`Default Build Config 0003 ${mode}`));
}
assert(doc.getSection('Build Dependencies 0003'));
assert.strictEqual(doc.getSection('Default Build Config 0003 Debug').get('Command Line Args'), '"--from-vscode"');
assert.strictEqual(doc.getSection('Default Build Config 0003 Debug').get('Working Directory'), '"/c/runtime/third-project"');
assert.strictEqual(doc.getSection('Default Build Config 0003 Debug').get('Environment Options'), '"MODE=scaffold"');
assert.strictEqual(doc.getSection('Default Build Config 0003 Debug').get('External Process Path'), '"/c/tools/third-runner.exe"');
assert.strictEqual(doc.getSection('Default Build Config 0003 Release').get('External Process Path'), '""');
assert.strictEqual(doc.getSection('Default Build Config 0001 Debug').get('External Process Path'), '"/c/Users/jerry.crozet/Documents/banc-cx4-evolution-json/Test.exe"');

const afterAutoInit = parser.inspectWorkspaceCompatibility(cws);
assert(afterAutoInit.some((issue) => issue.includes('[Default Build Config 0002 Debug] is missing')));
assert(!afterAutoInit.some((issue) => issue.includes('[Default Build Config 0003 Debug] is missing')));

const repaired = parser.repairWorkspaceCompatibility(cws);
assert.strictEqual(repaired.changed, true);
assert(repaired.changes.some((change) => change.includes('[Default Build Config 0002 Debug] added.')));
assert.deepStrictEqual(parser.inspectWorkspaceCompatibility(cws), []);
doc = IniDocument.parse(fs.readFileSync(cws, 'utf8'));
assert(doc.getSection('Project Header 0002'));
assert(doc.getSection('Build Dependencies 0002'));

const fourthPrj = parser.createProject(temp, 'Fourth', 'Dynamic Link Library', 'C:\\Program Files (x86)\\National Instruments\\CVI2020', 2000);
const fourthIndex = parser.addProjectToWorkspace(cws, fourthPrj);
assert.strictEqual(fourthIndex, 4);
doc = IniDocument.parse(fs.readFileSync(cws, 'utf8'));
assert(doc.getSection('Project Header 0004'));
assert(doc.getSection('Default Build Config 0004 Debug'));
assert(doc.getSection('Build Dependencies 0004'));
assert.deepStrictEqual(parser.inspectWorkspaceCompatibility(cws), []);

const freshRoot = path.join(temp, 'fresh');
const fresh = parser.createWorkspaceAndProject(freshRoot, 'FreshWorkspace', 'FreshProject', 'Executable', 'C:\\Program Files (x86)\\National Instruments\\CVI2020', 2000);
let freshDoc = IniDocument.parse(fs.readFileSync(fresh.workspacePath, 'utf8'));
assert(freshDoc.getSection('Project Header 0001'));
assert(freshDoc.getSection('Default Build Config 0001 Debug'));
assert(freshDoc.getSection('Build Dependencies 0001'));
assert.deepStrictEqual(parser.inspectWorkspaceCompatibility(fresh.workspacePath), []);
parser.setWorkspaceRunOptions(fresh.workspacePath, 1, 'debug', {
  arguments: '--fresh', workingDirectory: '', environmentOptions: '', externalProcessPath: ''
});
freshDoc = IniDocument.parse(fs.readFileSync(fresh.workspacePath, 'utf8'));
assert.strictEqual(freshDoc.getSection('Default Build Config 0001 Debug').get('Command Line Args'), '"--fresh"');

const backupDir = path.join(temp, '.vscode', 'cvi-native-backups');
assert(fs.existsSync(backupDir));
const backups = fs.readdirSync(backupDir).filter((entry) => entry.endsWith('.bak'));
assert(backups.length >= 3);

const result = {
  status: 'ok',
  userWorkspaceMissingSectionsDetectedBeforeMigration: before.length,
  project0003AutoInitializedOnRunSettingsSave: true,
  project0002InitializedByRepairCommand: true,
  newlyAddedProject0004InitializedImmediately: true,
  freshWorkspaceProject0001InitializedImmediately: true,
  compatibilityIssuesAfterRepair: parser.inspectWorkspaceCompatibility(cws).length,
  nativeBackupCount: backups.length
};
fs.writeFileSync(path.join(process.cwd(), 'WORKSPACE_PROJECT_SCAFFOLD_0.6.13_VALIDATION.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
