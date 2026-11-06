'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

function mkdir(p) { fs.mkdirSync(p, { recursive: true }); }
function touch(p, text = '') { mkdir(path.dirname(p)); fs.writeFileSync(p, text, 'utf8'); }
function normalize(p) { return path.resolve(p).replace(/\\/g, '/').toLowerCase(); }
function assert(condition, message) { if (!condition) throw new Error(message); }
function pass(name) { console.log(`PASS ${name}`); }
function inside(candidate, root) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvi-0734-intellisense-'));
const programFilesX86 = path.join(temp, 'Program Files (x86)');
const programFiles = path.join(temp, 'Program Files');
process.env['ProgramFiles(x86)'] = programFilesX86;
process.env.ProgramFiles = programFiles;

const installRoot = path.join(programFilesX86, 'National Instruments', 'CVI2013');
const sdkUm = path.join(programFilesX86, 'Windows Kits', '10', 'Include', '10.0.26100.0', 'um');
const sdkShared = path.join(programFilesX86, 'Windows Kits', '10', 'Include', '10.0.26100.0', 'shared');
const sdkUcrt = path.join(programFilesX86, 'Windows Kits', '10', 'Include', '10.0.26100.0', 'ucrt');
touch(path.join(installRoot, 'include', 'ansi', 'ansi.h'), '/* ansi */');
touch(path.join(installRoot, 'include', 'ansi_c.h'), '/* ansi aggregate */');
touch(path.join(installRoot, 'include', 'cvidef.h'), '#ifdef _NI_mswin64_\n#endif\n');
touch(path.join(installRoot, 'toolslib', 'toolbox', 'toolbox.h'), '/* toolbox */');
touch(path.join(installRoot, 'bin', 'clang', '3.3', 'clang.exe'), '');
touch(path.join(sdkUm, 'windows.h'), '');
touch(path.join(sdkShared, 'windef.h'), '');
touch(path.join(sdkUcrt, 'stdio.h'), '');

const root = path.join(temp, 'ws');
mkdir(root);
let settings = {
  autoConfigureCppTools: true,
  autoAddCviFolderToWorkspace: true,
  buildMode: 'debug',
  intelliSenseCompilerPath: '',
  additionalIncludePaths: [],
  customBuildConfiguration: ''
};
const logs = [];
let workspaceFolders = [{ uri: { fsPath: root }, name: 'ws' }];
const vscodeMock = {
  workspace: {
    getConfiguration: (section) => ({
      get: (key, fallback) => section === 'labwindowsCvi' && Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : fallback,
      update: async () => undefined,
      inspect: () => undefined
    }),
    get workspaceFolders() { return workspaceFolders; },
    getWorkspaceFolder: (uri) => workspaceFolders.find((folder) => inside(uri.fsPath, folder.uri.fsPath)),
    updateWorkspaceFolders: (_start, _del, ...items) => { workspaceFolders.push(...items.map(i => ({ uri: i.uri, name: i.name }))); return true; }
  },
  Uri: { file: (fsPath) => ({ scheme: 'file', fsPath: path.resolve(fsPath) }) },
  window: {
    showErrorMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    activeTextEditor: undefined
  },
  extensions: { getExtension: () => undefined },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  commands: { executeCommand: async () => undefined }
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return originalLoad.call(this, request, parent, isMain);
};

const { CviParser } = require('../out/model/cviParser.js');
const { CviCppToolsService } = require('../out/services/cviCppToolsService.js');
const parser = new CviParser();
const created = parser.createWorkspaceAndProject(root, 'MainWorkspace', 'ProjectA', 'Executable', installRoot, 1302);
const secondDir = path.join(root, 'ProjectBDir');
const projectB = parser.createProject(secondDir, 'ProjectB', 'Executable', installRoot, 1302);
parser.addProjectToWorkspace(created.workspacePath, projectB);

const aSrc = path.join(root, 'srcA');
const bSrc = path.join(secondDir, 'srcB');
const includeA = path.join(root, 'incA');
const includeB = path.join(secondDir, 'incB');
const forced = path.join(includeA, 'prefix.h');
touch(path.join(aSrc, 'main.c'), '#include "same.h"\n');
touch(path.join(aSrc, 'same.h'), '#define A_HEADER 1\n');
touch(path.join(bSrc, 'other.c'), '#include "same.h"\n');
touch(path.join(bSrc, 'same.h'), '#define B_HEADER 1\n');
touch(path.join(includeA, 'project_a.h'), '');
touch(path.join(includeB, 'project_b.h'), '');
touch(forced, '#define PREFIX_ACTIVE 1\n');
parser.addFilesToProject(created.projectPath, [path.join(aSrc, 'main.c'), path.join(aSrc, 'same.h')]);
parser.addFilesToProject(projectB, [path.join(bSrc, 'other.c'), path.join(bSrc, 'same.h')]);

let native = parser.getNativeCompilerSettings(created.projectPath, 'debug');
native.compilerDefines = '/DPROJECT_A /DVALUE=42 /DNAME="hello world" / /BROKEN';
native.enableC99Extensions = true;
parser.setNativeCompilerSettings(created.projectPath, 'debug', native);
let projectCompiler = parser.getProjectCompilerSettings(created.projectPath);
projectCompiler.includePaths = [includeA];
projectCompiler.precompilePrefixHeader = true;
projectCompiler.prefixHeaderFile = forced;
parser.setProjectCompilerSettings(created.projectPath, projectCompiler);

native = parser.getNativeCompilerSettings(created.projectPath, 'release64');
native.compilerDefines = '/DPROJECT_A_X64 /DVALUE=64';
native.enableC99Extensions = false;
parser.setNativeCompilerSettings(created.projectPath, 'release64', native);

let bCompiler = parser.getProjectCompilerSettings(projectB);
bCompiler.includePaths = [includeB];
parser.setProjectCompilerSettings(projectB, bCompiler);

const installation = {
  root: installRoot,
  label: 'CVI2013',
  compileExe: path.join(installRoot, 'bin', 'compile.exe'),
  ideExe: path.join(installRoot, 'bin', 'cvi.exe'),
  clangCcExe: path.join(installRoot, 'bin', 'clang', '3.3', 'clang.exe'),
  source: 'configured'
};
const installations = { getActiveInstallation: () => installation };
const output = { appendLine: (line) => logs.push(String(line)), show: () => undefined };
const service = new CviCppToolsService(installations, parser, output);

function managedConfig() {
  const configPath = path.join(root, '.vscode', 'c_cpp_properties.json');
  const doc = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return { doc, managed: doc.configurations.find(c => c.name === 'LabWindows/CVI (managed)'), configPath };
}

(async () => {
  let workspace = parser.parseWorkspace(created.workspacePath);
  await service.sync(workspace, false);
  let { doc, managed, configPath } = managedConfig();
  assert(managed, 'managed configuration missing');
  assert(managed.intelliSenseMode === 'windows-clang-x86', 'Debug must use x86 IntelliSense mode');
  pass('Debug uses windows-clang-x86');
  assert(managed.defines.includes('_NI_mswin32_=1') && !managed.defines.includes('_NI_mswin64_=1'), 'CVI x86 macro mismatch');
  pass('Debug exports CVI x86 macro');
  assert(managed.defines.includes('PROJECT_A') && managed.defines.includes('VALUE=42') && managed.defines.includes('NAME="hello world"'), 'project /D defines missing');
  assert(!managed.defines.includes('/') && !managed.defines.includes('BROKEN'), 'invalid compiler define leaked into IntelliSense');
  pass('valid /D defines propagated and invalid tokens ignored');
  assert(managed.defines.includes('_CVI_CONFIGURATION_NAME_="Debug"'), 'CVI 2013 configuration-name macro missing');
  pass('CVI 2013 configuration-name macro propagated');
  assert(managed.cStandard === 'c99', 'C99-enabled project must use c99 IntelliSense mode');
  pass('C99 extension state maps to c99');
  assert(managed.forcedInclude && managed.forcedInclude.map(normalize).includes(normalize(forced)), 'prefix header not mapped to forcedInclude');
  pass('prefix header maps to forcedInclude');
  const includeNorm = managed.includePath.map(p => p.includes('${workspaceFolder}') ? p : normalize(p.replace(/\/\*\*$/, '')));
  assert(includeNorm.includes(normalize(includeA)), 'active project include path missing');
  assert(managed.includePath.findIndex(p => normalize(p.replace(/\/\*\*$/, '')) === normalize(includeA)) < managed.includePath.findIndex(p => normalize(p.replace(/\/\*\*$/, '')) === normalize(path.join(installRoot, 'include'))), 'project include path must precede CVI system headers');
  pass('project include paths keep compiler search priority');
  assert(!includeNorm.includes(normalize(includeB)), 'inactive project include path leaked into semantic includePath');
  assert(includeNorm.includes(normalize(aSrc)), 'active project source directory missing');
  assert(!includeNorm.includes(normalize(bSrc)), 'inactive project source directory leaked into semantic includePath');
  assert(!managed.includePath.includes('${workspaceFolder}/**'), 'recursive workspace wildcard must not be used for semantic includes');
  pass('semantic includePath isolated to active project');
  const browseNorm = managed.browse.path.map(p => p.includes('${workspaceFolder}') ? p : normalize(p));
  assert(browseNorm.includes(normalize(aSrc)) && browseNorm.includes(normalize(bSrc)), 'browse.path should cover all workspace projects');
  pass('browse.path covers all workspace projects');
  assert(normalize(managed.compilerPath) === normalize(installation.clangCcExe), 'CVI clang compilerPath missing');
  pass('CVI compilerPath retained');

  // Preserve a user-owned configuration while updating the managed entry.
  doc.configurations.push({ name: 'UserConfig', includePath: ['C:/user/include'], defines: ['USER_DEFINED'] });
  fs.writeFileSync(configPath, JSON.stringify(doc, null, 2));
  await service.sync(workspace, false);
  ({ doc, managed } = managedConfig());
  assert(doc.configurations.some(c => c.name === 'UserConfig' && c.defines.includes('USER_DEFINED')), 'user configuration was overwritten');
  pass('user c_cpp_properties configurations preserved');

  // Change the native CVI workspace mode and resynchronize.
  parser.setWorkspaceProjectBuildMode(created.workspacePath, 1, 'release64');
  workspace = parser.parseWorkspace(created.workspacePath);
  await service.sync(workspace, false);
  ({ managed } = managedConfig());
  assert(managed.intelliSenseMode === 'windows-clang-x64', 'Release64 must use x64 IntelliSense mode');
  assert(managed.defines.includes('_NI_mswin64_=1') && managed.defines.includes('_WIN64=1'), 'x64 macros missing');
  assert(!managed.defines.includes('_NI_mswin32_=1'), 'x86 CVI macro remained after x64 switch');
  assert(managed.defines.includes('NDEBUG'), 'Release mode must expose CVI NDEBUG macro');
  assert(managed.defines.includes('PROJECT_A_X64') && managed.defines.includes('VALUE=64'), 'Release64 compiler defines missing');
  assert(!managed.defines.includes('PROJECT_A'), 'Debug compiler defines leaked into Release64');
  assert(managed.defines.includes('_CVI_CONFIGURATION_NAME_="Release64"'), 'configuration-name macro did not update');
  assert(managed.cStandard === 'c89', 'C99-disabled project must use c89 IntelliSense mode');
  pass('Release64 switch refreshes architecture, macros, defines and C standard');

  // Switch active project: semantic include paths must follow the new active project.
  parser.setWorkspaceActiveProject(created.workspacePath, 2);
  workspace = parser.parseWorkspace(created.workspacePath);
  await service.sync(workspace, false);
  ({ managed } = managedConfig());
  const includeBActive = managed.includePath.map(p => p.includes('${workspaceFolder}') ? p : normalize(p.replace(/\/\*\*$/, '')));
  assert(includeBActive.includes(normalize(includeB)) && !includeBActive.includes(normalize(includeA)), 'active project include paths did not switch');
  assert(includeBActive.includes(normalize(bSrc)) && !includeBActive.includes(normalize(aSrc)), 'active project source directories did not switch');
  pass('active-project switch refreshes semantic include paths');

  // A custom native configuration cannot yet be deserialized; it must be explicit in diagnostics and use fallback mode.
  let cws = fs.readFileSync(created.workspacePath, 'utf8');
  cws = cws.replace(/(\[Project Header 0002\][\s\S]*?Build Configuration\s*=\s*)"[^"]*"/i, '$1"QA_CUSTOM"');
  fs.writeFileSync(created.workspacePath, cws, 'utf8');
  settings.buildMode = 'release64';
  workspace = parser.parseWorkspace(created.workspacePath);
  await service.sync(workspace, false);
  ({ managed } = managedConfig());
  assert(managed.intelliSenseMode === 'windows-clang-x64', 'custom config fallback mode not applied');
  assert(logs.some(line => line.includes('QA_CUSTOM') && line.includes('not safely recognized')), 'custom configuration limitation not reported');
  pass('custom native configuration fallback is explicit');

  // The extension-level named build configuration used by compile.exe must also be explicit.
  parser.setWorkspaceActiveProject(created.workspacePath, 1);
  settings.buildMode = 'debug';
  settings.customBuildConfiguration = '"QA_SETTING"';
  workspace = parser.parseWorkspace(created.workspacePath);
  await service.sync(workspace, false);
  ({ managed } = managedConfig());
  assert(managed.defines.includes('_CVI_CONFIGURATION_NAME_="QA_SETTING"'), 'named build configuration macro missing');
  assert(logs.some(line => line.includes('QA_SETTING') && line.includes('not safely recognized')), 'extension named configuration limitation not reported');
  pass('extension named build configuration is reflected without inventing compiler fields');
  settings.customBuildConfiguration = '';

  console.log('RESULT 15 passed, 0 failed');
})().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
