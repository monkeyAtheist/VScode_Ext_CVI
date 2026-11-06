const fs = require('fs');
const os = require('os');
const path = require('path');
const { CviParser } = require('../out/model/cviParser');

const fixtureRoot = '/mnt/data/example_workspace/Exemple Workspace_projet';
let passed = 0, failed = 0;
function check(name, condition, detail='') {
  if (condition) { console.log(`PASS ${name}${detail ? ' :: ' + detail : ''}`); passed++; }
  else { console.log(`FAIL ${name}${detail ? ' :: ' + detail : ''}`); failed++; }
}
function clone(file, dir) { const dest = path.join(dir, path.basename(file)); fs.copyFileSync(file, dest); return dest; }
const parser = new CviParser();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvi0733-'));
try {
  const gr = clone(path.join(fixtureRoot, 'GR_IHM.prj'), temp);
  const debug = parser.getNativeCompilerSettings(gr, 'debug');
  const debug64 = parser.getNativeCompilerSettings(gr, 'debug64');
  check('Debug configuration parsed as x86/debug', !debug.is64Bit && !debug.isRelease);
  check('Debug64 configuration parsed as x64/debug', debug64.is64Bit && !debug64.isRelease);
  check('legacy warning mode parsed', debug.uninitializedLocalsCompileWarning === 'Aggressive', debug.uninitializedLocalsCompileWarning);
  check('compiler defines parsed from selected configuration', debug.compilerDefines.includes('WIN32_LEAN_AND_MEAN'));

  const issues = parser.inspectNativeCompilerConfiguration(gr, 'debug64');
  check('malformed standalone slash define is reported', issues.some(x => x.field === 'Compiler Defines' && x.message.includes('"/"')));
  check('non-/D project define is reported conservatively', issues.some(x => x.message.includes('/__GR_IHM_PROJECT__')));

  const releaseBefore = parser.getNativeCompilerSettings(gr, 'release');
  const rawBefore = fs.readFileSync(gr, 'utf8');
  debug.compilerDefines = '/DWIN32_LEAN_AND_MEAN /DUNIT_TEST=1';
  debug.stackSize = '333333';
  debug.requirePrototypes = false;
  parser.setNativeCompilerSettings(gr, 'debug', debug);
  const debugAfter = parser.getNativeCompilerSettings(gr, 'debug');
  const releaseAfter = parser.getNativeCompilerSettings(gr, 'release');
  check('selected configuration compiler values are writable', debugAfter.compilerDefines.includes('/DUNIT_TEST=1') && debugAfter.stackSize === '333333' && !debugAfter.requirePrototypes);
  check('other build configuration remains unchanged', JSON.stringify(releaseAfter) === JSON.stringify(releaseBefore));
  const rawAfter = fs.readFileSync(gr, 'utf8');
  check('old project does not gain unsupported Optimization Level key', !rawAfter.includes('Optimization Level ='));
  check('old project does not gain unsupported OpenMP key', !rawAfter.includes('Enable OpenMP Extensions ='));
  check('native mode invariants remain coherent after write', !debugAfter.is64Bit && !debugAfter.isRelease);

  const incA = path.join(temp, 'incA'); const incB = path.join(temp, 'incB');
  fs.mkdirSync(incA); fs.mkdirSync(incB);
  const projectCompiler = parser.getProjectCompilerSettings(gr);
  projectCompiler.includePaths = [incA, incB, incA];
  projectCompiler.oOptionCompatibleWith50 = true;
  projectCompiler.precompilePrefixHeader = true;
  projectCompiler.prefixHeaderFile = path.join(incA, 'prefix.h');
  fs.writeFileSync(projectCompiler.prefixHeaderFile, '#pragma once\n');
  parser.setProjectCompilerSettings(gr, projectCompiler);
  const projectCompilerAfter = parser.getProjectCompilerSettings(gr);
  check('include path order is preserved and duplicates removed', projectCompilerAfter.includePaths.length === 2 && path.resolve(projectCompilerAfter.includePaths[0]) === path.resolve(incA) && path.resolve(projectCompilerAfter.includePaths[1]) === path.resolve(incB));
  check('project-wide legacy/prefix settings round-trip', projectCompilerAfter.oOptionCompatibleWith50 && projectCompilerAfter.precompilePrefixHeader && path.resolve(projectCompilerAfter.prefixHeaderFile) === path.resolve(projectCompiler.prefixHeaderFile));

  const projectBeforeFlags = parser.parseProject(gr).files.map(f => [f.id, f.excluded, f.compileIntoObjectFile]);
  const d2 = parser.getNativeCompilerSettings(gr, 'debug');
  d2.requireReturnValues = !d2.requireReturnValues;
  parser.setNativeCompilerSettings(gr, 'debug', d2);
  const projectAfterFlags = parser.parseProject(gr).files.map(f => [f.id, f.excluded, f.compileIntoObjectFile]);
  check('per-file Exclude/Object flags survive compiler writes', JSON.stringify(projectBeforeFlags) === JSON.stringify(projectAfterFlags));

  const cws = clone(path.join(fixtureRoot, 'IHM_WorkSpace.cws'), temp);
  const wsDebug = parser.getWorkspaceNativeBuildOptions(cws, 1, 'debug');
  const wsReleaseBefore = parser.getWorkspaceNativeBuildOptions(cws, 1, 'release');
  check('workspace build/debug options are parsed', !!wsDebug && typeof wsDebug.generateBrowseInfo === 'boolean' && !!wsDebug.debuggingLevel);
  if (wsDebug) {
    wsDebug.generateBrowseInfo = !wsDebug.generateBrowseInfo;
    wsDebug.debuggingLevel = '0733-Test-Level';
    wsDebug.breakOnLibraryErrors = true;
    parser.setWorkspaceNativeBuildOptions(cws, 1, 'debug', wsDebug);
    const wsDebugAfter = parser.getWorkspaceNativeBuildOptions(cws, 1, 'debug');
    const wsReleaseAfter = parser.getWorkspaceNativeBuildOptions(cws, 1, 'release');
    check('workspace selected-mode build options are writable', !!wsDebugAfter && wsDebugAfter.debuggingLevel === '0733-Test-Level' && wsDebugAfter.breakOnLibraryErrors);
    check('workspace other mode remains unchanged except shared break flags', !!wsReleaseBefore && !!wsReleaseAfter && wsReleaseAfter.debuggingLevel === wsReleaseBefore.debuggingLevel && wsReleaseAfter.generateBrowseInfo === wsReleaseBefore.generateBrowseInfo);
  }

  const prefixIssueProject = clone(path.join(fixtureRoot, 'selecteur.prj'), temp);
  const pc = parser.getProjectCompilerSettings(prefixIssueProject);
  pc.precompilePrefixHeader = true; pc.prefixHeaderFile = '';
  parser.setProjectCompilerSettings(prefixIssueProject, pc);
  check('missing prefix header is diagnosed when precompile is enabled', parser.inspectNativeCompilerConfiguration(prefixIssueProject, 'debug').some(x => x.field === 'Prefix Header File'));

  const panelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'buildSettingsPanel.ts'), 'utf8');
  check('Build Settings exposes Compiler & Linker page', panelSource.includes("label: 'Compiler & Linker'") && panelSource.includes('id="compilerDefines"') && panelSource.includes('id="includePaths"'));
  const buildSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'cviBuildService.ts'), 'utf8');
  check('build preflight logs compiler configuration and warnings', buildSource.includes('Compiler configuration warnings:') && buildSource.includes('recordSyntheticWarning'));

  console.log(`RESULT ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
