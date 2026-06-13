const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CviParser } = require('../out/model/cviParser');

const sourceRoot = '/mnt/data/cvi_prj_inspect/CVI_PRJ';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvi-user-breakpoint-fixture-'));
const workspacePath = path.join(temp, 'Source File.cws');
const projectPath = path.join(temp, 'Source File.prj');
for (const name of ['Source File.cws', 'Source File.prj', 'Source File.c', 'Source File.h', 'UIR.h', 'UIR.uir']) {
  fs.copyFileSync(path.join(sourceRoot, name), path.join(temp, name));
}
const cviTemp = temp.replace(/\\/g, '/');
fs.writeFileSync(workspacePath, fs.readFileSync(workspacePath, 'utf8').replaceAll('/c/Users/jerry.crozet/Downloads/CVI_PRJ', cviTemp));
const parser = new CviParser();
const project = parser.parseProject(projectPath);
const source = project.files.find((entry) => entry.type === 'CSource');
assert(source, 'C source file not found in uploaded CVI project');

const initial = fs.readFileSync(workspacePath, 'utf8');
assert(initial.includes('Breakpoint 0001 = "39,0,enabled,"'));
assert(initial.includes('Breakpoint 0002 = "43,0,enabled,"'));
assert(initial.includes('Tracepoint 0001 = "0,0,41,1,"'));
assert(initial.includes('Tracepoint 0002 = "0,0,44,1,"'));

const sync = parser.synchronizeWorkspaceBreakpoints(workspacePath, 1, projectPath, [
  { filePath: source.absolutePath, line: 45 }
]);
assert.strictEqual(sync.appliedCount, 1);
assert.strictEqual(sync.preservedNativeCount, 2);
assert.deepStrictEqual(sync.trackedBreakpoints.map((entry) => entry.line), [45]);
let updated = fs.readFileSync(workspacePath, 'utf8');
assert(updated.includes('Breakpoint 0001 = "39,0,enabled,"'));
assert(updated.includes('Breakpoint 0002 = "43,0,enabled,"'));
assert(updated.includes('Breakpoint 0003 = "45,0,enabled,"'));
assert(updated.includes('Tracepoint 0001 = "0,0,41,1,"'));
assert(updated.includes('Tracepoint 0002 = "0,0,44,1,"'));

const clear = parser.synchronizeWorkspaceBreakpoints(workspacePath, 1, projectPath, [], sync.trackedBreakpoints);
assert.strictEqual(clear.removedTrackedCount, 1);
assert.strictEqual(clear.preservedNativeCount, 2);
updated = fs.readFileSync(workspacePath, 'utf8');
assert(updated.includes('Breakpoint 0001 = "39,0,enabled,"'));
assert(updated.includes('Breakpoint 0002 = "43,0,enabled,"'));
assert(!updated.includes('"45,0,enabled,"'));
assert(updated.includes('Tracepoint 0001 = "0,0,41,1,"'));
assert(updated.includes('Tracepoint 0002 = "0,0,44,1,"'));

console.log(JSON.stringify({
  version: '0.6.14',
  uploadedWorkspaceFixture: 'CVI_PRJ/Source File.cws',
  preExistingNativeBreakpointsPreserved: [39, 43],
  synchronizedBreakpointAddedThenRemoved: 45,
  tracepointsPreserved: [41, 44],
  nativeBackupCreated: fs.existsSync(path.join(temp, '.vscode', 'cvi-native-backups'))
}, null, 2));
