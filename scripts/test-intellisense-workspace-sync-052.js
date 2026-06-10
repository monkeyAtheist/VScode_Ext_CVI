'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

function mkdir(filePath) { fs.mkdirSync(filePath, { recursive: true }); }
function touch(filePath, text = '') { mkdir(path.dirname(filePath)); fs.writeFileSync(filePath, text, 'utf8'); }
function normalize(value) { return path.resolve(value).toLowerCase(); }
function inside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvi-intellisense-052-'));
const programFilesX86 = path.join(temp, 'Program Files (x86)');
const programFiles = path.join(temp, 'Program Files');
process.env['ProgramFiles(x86)'] = programFilesX86;
process.env.ProgramFiles = programFiles;

const installationRoot = path.join(programFilesX86, 'National Instruments', 'CVI2020');
const workspaceRoot = path.join(temp, 'workspace');
const workspacePath = path.join(workspaceRoot, 'sample.cws');
const projectPath = path.join(workspaceRoot, 'sample.prj');
const sourcePath = path.join(workspaceRoot, 'src', 'main.c');
const sdkUm = path.join(programFilesX86, 'Windows Kits', '10', 'Include', '10.0.26100.0', 'um');
const sdkShared = path.join(programFilesX86, 'Windows Kits', '10', 'Include', '10.0.26100.0', 'shared');
const sdkUcrt = path.join(programFilesX86, 'Windows Kits', '10', 'Include', '10.0.26100.0', 'ucrt');

touch(path.join(installationRoot, 'include', 'ansi', 'ansi.h'), '/* CVI ANSI */');
touch(path.join(installationRoot, 'include', 'ansi_c.h'), '/* CVI ANSI aggregate */');
touch(path.join(installationRoot, 'include', 'userint.h'), '/* CVI UI */');
touch(path.join(installationRoot, 'toolslib', 'toolbox', 'toolbox.h'), '/* CVI toolbox */');
touch(path.join(installationRoot, 'bin', 'clang', '3.3', 'clang.exe'), '');
touch(path.join(sdkUm, 'windows.h'), '/* Windows SDK */');
touch(path.join(sdkShared, 'windef.h'), '');
touch(path.join(sdkUcrt, 'stdio.h'), '');
touch(workspacePath, '');
touch(projectPath, '');
touch(sourcePath, '#include <windows.h>\n#include <ansi.h>\n#include <toolbox.h>\n');

let workspaceFolders = [];
const logs = [];
const settings = {
  autoAddCviFolderToWorkspace: true,
  autoConfigureCppTools: true,
  useCppToolsConfigurationProvider: true,
  intelliSenseCompilerPath: '',
  additionalIncludePaths: []
};
const vscodeMock = {
  workspace: {
    getConfiguration: () => ({ get: (key, fallback) => Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : fallback }),
    get workspaceFolders() { return workspaceFolders; },
    getWorkspaceFolder: (uri) => workspaceFolders.find((folder) => inside(uri.fsPath, folder.uri.fsPath)),
    updateWorkspaceFolders: (_start, _deleteCount, ...items) => {
      workspaceFolders.push(...items.map((item) => ({ uri: item.uri, name: item.name })));
      return true;
    }
  },
  Uri: { file: (fsPath) => ({ scheme: 'file', fsPath: path.resolve(fsPath) }) },
  extensions: { getExtension: () => undefined },
  window: {
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    activeTextEditor: undefined
  }
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return originalLoad.call(this, request, parent, isMain);
};

const { CviCppToolsService } = require('../out/services/cviCppToolsService.js');
const installation = {
  root: installationRoot,
  label: 'CVI2020',
  compileExe: path.join(installationRoot, 'bin', 'compile.exe'),
  ideExe: path.join(installationRoot, 'bin', 'cvi.exe'),
  clangCcExe: path.join(installationRoot, 'bin', 'clang', '3.3', 'clang.exe'),
  source: 'configured'
};
const workspace = {
  path: workspacePath,
  name: 'sample',
  activeProjectIndex: 1,
  projects: [{ index: 1, relativePath: 'sample.prj', absolutePath: projectPath, name: 'sample', exists: true }]
};
const installations = { getActiveInstallation: () => installation };
const parser = { parseProject: () => ({ files: [{ absolutePath: sourcePath }] }) };
const output = { appendLine: (line) => logs.push(line), show: () => undefined };
const service = new CviCppToolsService(installations, parser, output);

(async () => {
  const added = await service.ensureConfigurationRootInWorkspace(workspace);
  if (!added) throw new Error('CVI root was not added to the standard VS Code Explorer');
  if (!workspaceFolders.some((folder) => normalize(folder.uri.fsPath) === normalize(workspaceRoot))) throw new Error('Unexpected Explorer folder');

  const configPath = await service.sync(workspace, false);
  if (!configPath || !fs.existsSync(configPath)) throw new Error('c_cpp_properties.json was not generated');
  const document = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const managed = document.configurations.find((entry) => entry.name === 'LabWindows/CVI (managed)');
  if (!managed) throw new Error('Managed IntelliSense configuration missing');

  const providerPaths = service.getProviderPaths(workspace, installation);
  const dynamic = providerPaths.includePath.map(normalize);
  const staticPaths = managed.includePath.map((entry) => entry.includes('${workspaceFolder}') ? entry : normalize(entry.replace(/[\\/]\*\*$/, '')));
  for (const expected of [path.join(installationRoot, 'include', 'ansi'), sdkUm, sdkShared, sdkUcrt]) {
    if (!dynamic.includes(normalize(expected))) throw new Error(`Dynamic provider path missing: ${expected}`);
    if (!staticPaths.includes(normalize(expected))) throw new Error(`Static include path missing: ${expected}`);
  }
  if (!managed.compilerPath || normalize(managed.compilerPath) !== normalize(installation.clangCcExe)) throw new Error('compilerPath missing or invalid');
  if (!managed.configurationProvider) throw new Error('configurationProvider missing');

  const result = {
    status: 'ok',
    version: '0.5.2',
    standardExplorerFolderAdded: true,
    generatedConfig: configPath,
    compilerPath: managed.compilerPath,
    ansiIncludeDetected: dynamic.includes(normalize(path.join(installationRoot, 'include', 'ansi'))),
    windowsSdkUmDetected: dynamic.includes(normalize(sdkUm)),
    windowsSdkSharedDetected: dynamic.includes(normalize(sdkShared)),
    windowsSdkUcrtDetected: dynamic.includes(normalize(sdkUcrt)),
    providerIncludeDirectoryCount: providerPaths.includePath.length,
    logs
  };
  fs.writeFileSync('INTELLISENSE_WORKSPACE_SYNC_0.5.2_VALIDATION.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
})().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
