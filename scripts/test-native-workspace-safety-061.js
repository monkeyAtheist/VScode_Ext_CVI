const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { CviParser } = require('../out/model/cviParser');
const { IniDocument } = require('../out/model/iniDocument');

const source = '/mnt/data/mco_orig/MCO_MSR/MSR_TEST.cws';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvi061-'));
const cws = path.join(temp, 'MSR_TEST.cws');
fs.copyFileSync(source, cws);
const parser = new CviParser();

const beforeIssues = parser.inspectWorkspaceCompatibility(cws);
assert(beforeIssues.length >= 3, `expected compatibility issues, got ${beforeIssues.length}`);
assert(beforeIssues.some(x => x.includes('unexpected External Process Path')));
assert(beforeIssues.some(x => x.includes('duplicates per-configuration Command Line Args')));
assert(beforeIssues.some(x => x.includes('DLL Debugging Support')));

const repaired = parser.repairWorkspaceCompatibility(cws);
assert.strictEqual(repaired.changed, true);
const afterRepairIssues = parser.inspectWorkspaceCompatibility(cws);
assert.deepStrictEqual(afterRepairIssues, []);

let doc = IniDocument.parse(fs.readFileSync(cws, 'utf8'));
const debug = doc.getSection('Default Build Config 0001 Debug');
const legacyArgs = doc.getSection('Command Line Args 0001');
const legacyDll = doc.getSection('DLL Debugging Support 0001');
assert(debug && legacyArgs && legacyDll);
assert.strictEqual(debug.get('External Process Path'), '"/c/PROG_CVI/EXE/MATRIX/MATRIX.exe"');
assert.strictEqual(legacyArgs.get('External Process Path'), undefined);
assert.strictEqual(legacyArgs.get('Command Line Args'), '""');
assert.strictEqual(legacyDll.get('External Process Path'), '""');

parser.setWorkspaceRunOptions(cws, 1, 'debug', {
  arguments: '--sample value',
  workingDirectory: 'D:\\runtime\\folder',
  environmentOptions: 'MODE=test',
  externalProcessPath: 'C:\\tools\\runner.exe'
});

doc = IniDocument.parse(fs.readFileSync(cws, 'utf8'));
const debug2 = doc.getSection('Default Build Config 0001 Debug');
const legacyArgs2 = doc.getSection('Command Line Args 0001');
const legacyDll2 = doc.getSection('DLL Debugging Support 0001');
assert(debug2 && legacyArgs2 && legacyDll2);
assert.strictEqual(debug2.get('Command Line Args'), '"--sample value"');
assert.strictEqual(debug2.get('Working Directory'), '"/d/runtime/folder"');
assert.strictEqual(debug2.get('Environment Options'), '"MODE=test"');
assert.strictEqual(debug2.get('External Process Path'), '"/c/tools/runner.exe"');
assert.strictEqual(legacyArgs2.get('Command Line Args'), '""');
assert.strictEqual(legacyArgs2.get('External Process Path'), undefined);
assert.strictEqual(legacyDll2.get('External Process Path'), '""');

const readBack = parser.getWorkspaceRunOptions(cws, 1, 'debug');
assert.strictEqual(readBack.externalProcessPath, '/c/tools/runner.exe');
assert.strictEqual(readBack.workingDirectory, '/d/runtime/folder');
assert.strictEqual(readBack.arguments, '--sample value');

const backupDir = path.join(temp, '.vscode', 'cvi-native-backups');
assert(fs.existsSync(backupDir));
const backups = fs.readdirSync(backupDir).filter(x => x.endsWith('.bak'));
assert(backups.length >= 2, `expected at least two backups, got ${backups.length}`);

const result = {
  status: 'ok',
  detectedIssuesBeforeRepair: beforeIssues.length,
  detectedIssuesAfterRepair: afterRepairIssues.length,
  repairChanges: repaired.changes,
  persistedDebugExternalProcessPath: debug2.get('External Process Path'),
  persistedDebugWorkingDirectory: debug2.get('Working Directory'),
  legacyCommandLineArgsExternalProcessPath: legacyArgs2.get('External Process Path') ?? null,
  legacyDllDebuggingExternalProcessPath: legacyDll2.get('External Process Path'),
  nativeBackupCount: backups.length
};
fs.writeFileSync('/mnt/data/NATIVE_WORKSPACE_SAFETY_0.6.1_VALIDATION.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
