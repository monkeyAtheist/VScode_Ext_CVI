const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CviParser } = require('../out/model/cviParser');

function read(filePath) { return fs.readFileSync(filePath, 'utf8'); }
function occurrence(text, pattern) { return (text.match(pattern) || []).length; }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cvi-breakpoint-sync-'));
const parser = new CviParser();
const { workspacePath, projectPath } = parser.createWorkspaceAndProject(root, 'Bridge', 'Application', 'Executable', undefined, 2000);
const sourceA = path.join(root, 'Main.c');
const sourceB = path.join(root, 'Worker.c');
const outside = path.join(root, 'Outside.c');
fs.writeFileSync(sourceA, 'int main(void) {\n  return 0;\n}\n');
fs.writeFileSync(sourceB, 'void worker(void) {}\n');
fs.writeFileSync(outside, 'void outside(void) {}\n');
assert.strictEqual(parser.addFilesToProject(projectPath, [sourceA, sourceB]), 2);

// Add one native CVI breakpoint and one tracepoint manually, simulating a workspace
// that was previously opened and saved in LabWindows/CVI.
let cws = read(workspacePath);
cws = cws.replace('[Default Build Config 0001 Debug]', `[File 0001]\nPath = "${sourceA.replace(/\\/g, '/')}"\nFile Type = "CSource"\nIn Projects = "1,"\nSource Window State = "minimal"\nBreakpoint 0001 = "12,0,enabled,"\nTracepoint 0001 = "0,0,13,1,"\n\n[Default Build Config 0001 Debug]`);
cws = cws.replace('Sort Type = "File Name"', 'Sort Type = "File Name"\nNumber of Opened Files = 1');
fs.writeFileSync(workspacePath, cws);

const first = parser.synchronizeWorkspaceBreakpoints(workspacePath, 1, projectPath, [
  { filePath: sourceA, line: 20 },
  { filePath: sourceB, line: 33 },
  { filePath: outside, line: 99 }
]);
assert.strictEqual(first.changed, true);
assert.strictEqual(first.appliedCount, 2);
assert.strictEqual(first.preservedNativeCount, 1);
assert.strictEqual(first.ignoredBreakpoints.length, 1);
assert.strictEqual(first.createdWorkspaceFileSections.length, 1);
assert.deepStrictEqual(first.trackedBreakpoints.map((entry) => [path.basename(entry.filePath), entry.line]).sort(), [['Main.c', 20], ['Worker.c', 33]]);
let afterFirst = read(workspacePath);
assert(afterFirst.includes('Breakpoint 0001 = "12,0,enabled,"'));
assert(afterFirst.includes('Breakpoint 0002 = "20,0,enabled,"'));
assert(afterFirst.includes('Breakpoint 0001 = "33,0,enabled,"'));
assert(afterFirst.includes('Tracepoint 0001 = "0,0,13,1,"'));
assert(afterFirst.includes('Number of Opened Files = 2'));
assert(fs.existsSync(path.join(root, '.vscode', 'cvi-native-backups')));

const second = parser.synchronizeWorkspaceBreakpoints(workspacePath, 1, projectPath, [
  { filePath: sourceB, line: 34 }
], first.trackedBreakpoints);
assert.strictEqual(second.changed, true);
assert.strictEqual(second.appliedCount, 1);
assert.strictEqual(second.preservedNativeCount, 1);
assert.strictEqual(second.removedTrackedCount, 2);
assert.deepStrictEqual(second.trackedBreakpoints.map((entry) => [path.basename(entry.filePath), entry.line]), [['Worker.c', 34]]);
let afterSecond = read(workspacePath);
assert(afterSecond.includes('Breakpoint 0001 = "12,0,enabled,"'));
assert(!afterSecond.includes('"20,0,enabled,"'));
assert(!afterSecond.includes('"33,0,enabled,"'));
assert(afterSecond.includes('Breakpoint 0001 = "34,0,enabled,"'));
assert(afterSecond.includes('Tracepoint 0001 = "0,0,13,1,"'));

const cleared = parser.synchronizeWorkspaceBreakpoints(workspacePath, 1, projectPath, [], second.trackedBreakpoints);
assert.strictEqual(cleared.changed, true);
assert.strictEqual(cleared.appliedCount, 0);
assert.strictEqual(cleared.preservedNativeCount, 1);
assert.strictEqual(cleared.removedTrackedCount, 1);
assert.deepStrictEqual(cleared.trackedBreakpoints, []);
let afterClear = read(workspacePath);
assert(afterClear.includes('Breakpoint 0001 = "12,0,enabled,"'));
assert(!afterClear.includes('"34,0,enabled,"'));
assert(afterClear.includes('Tracepoint 0001 = "0,0,13,1,"'));

// A VS Code breakpoint matching an existing native CVI breakpoint must not replace
// the native serialization or become extension-owned.
const nativeOverlap = parser.synchronizeWorkspaceBreakpoints(workspacePath, 1, projectPath, [
  { filePath: sourceA, line: 12 }
], []);
assert.strictEqual(nativeOverlap.appliedCount, 1);
assert.strictEqual(nativeOverlap.preservedNativeCount, 1);
assert.deepStrictEqual(nativeOverlap.trackedBreakpoints, []);
assert.strictEqual(occurrence(read(workspacePath), /Breakpoint \d{4} = "12,0,enabled,"/g), 1);

console.log(JSON.stringify({
  version: '0.6.14',
  firstSync: {
    applied: first.appliedCount,
    preservedNative: first.preservedNativeCount,
    ignoredOutsideProject: first.ignoredBreakpoints.length,
    createdWorkspaceFileSections: first.createdWorkspaceFileSections.length
  },
  resync: {
    applied: second.appliedCount,
    removedTracked: second.removedTrackedCount,
    preservedNative: second.preservedNativeCount
  },
  clear: {
    removedTracked: cleared.removedTrackedCount,
    preservedNative: cleared.preservedNativeCount
  },
  tracepointPreserved: true,
  nativeOverlapPreserved: true,
  nativeBackupCreated: true
}, null, 2));
