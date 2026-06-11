const fs = require('fs');
const os = require('os');
const path = require('path');
const { CviParser } = require('../out/model/cviParser');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cvi-native-056-'));
const sourceRoot = process.argv[2];
if (!sourceRoot) throw new Error('Pass extracted PrjCVI folder');
for (const name of ['HNF_version_list.prj', 'HNF_version_list.cws']) {
  fs.copyFileSync(path.join(sourceRoot, name), path.join(root, name));
}
const prj = path.join(root, 'HNF_version_list.prj');
const cws = path.join(root, 'HNF_version_list.cws');
const parser = new CviParser();

const debugActions = parser.getProjectBuildActions(prj, 'debug');
if (!debugActions.nativeSectionsPresent) throw new Error('Native debug action sections not detected');
if (debugActions.preBuildActions[0] !== 'Pre build actions') throw new Error('Unexpected pre-build action');
if (debugActions.customBuildActions[0] !== 'Custom build actions') throw new Error('Unexpected custom action');
if (debugActions.postBuildActions[0] !== 'Post build actions') throw new Error('Unexpected post-build action');

const debugRun = parser.getWorkspaceRunOptions(cws, 1, 'debug');
if (debugRun.arguments !== 'Comment line arguments') throw new Error('Debug arguments not read from native cws section');
if (debugRun.workingDirectory !== 'Working directories') throw new Error('Debug working directory not read');
if (debugRun.environmentOptions !== 'Environnement options') throw new Error('Debug environment not read');

parser.setProjectBuildActions(prj, 'release', {
  preBuildActions: ['echo release-pre'],
  customBuildActions: ['echo release-custom'],
  postBuildActions: ['echo release-post']
});
const releaseActions = parser.getProjectBuildActions(prj, 'release');
if (!releaseActions.nativeSectionsPresent || releaseActions.preBuildActions[0] !== 'echo release-pre') throw new Error('Release action persistence failed');

parser.setWorkspaceRunOptions(cws, 1, 'debug64', {
  arguments: '--x64',
  workingDirectory: 'C:/work',
  environmentOptions: 'MODE=x64',
  externalProcessPath: 'C:/host.exe'
});
const debug64Run = parser.getWorkspaceRunOptions(cws, 1, 'debug64');
if (debug64Run.arguments !== '--x64' || debug64Run.workingDirectory !== 'C:/work' || debug64Run.environmentOptions !== 'MODE=x64' || debug64Run.externalProcessPath !== 'C:/host.exe') throw new Error('Debug64 native cws write failed');
const stillDebug = parser.getWorkspaceRunOptions(cws, 1, 'debug');
if (stillDebug.arguments !== 'Comment line arguments') throw new Error('Writing Debug64 unexpectedly overwrote Debug');

const prjText = fs.readFileSync(prj, 'utf8');
const cwsText = fs.readFileSync(cws, 'utf8');
for (const marker of ['[Release Pre-build Actions]', '[Release Custom Build Actions]', '[Release Post-build Actions]']) {
  if (!prjText.includes(marker)) throw new Error(`Missing ${marker}`);
}
if (!cwsText.includes('[Default Build Config 0001 Debug64]') || !cwsText.includes('Command Line Args = "--x64"')) throw new Error('Missing native Debug64 cws fields');

console.log(JSON.stringify({
  status: 'ok',
  sourceRoot,
  nativeDebugActions: debugActions,
  nativeDebugRun: debugRun,
  writtenReleaseActions: releaseActions,
  writtenDebug64Run: debug64Run,
  debugPreservedAfterDebug64Write: stillDebug.arguments
}, null, 2));
