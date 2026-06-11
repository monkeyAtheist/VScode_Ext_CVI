const fs = require('fs');
const path = require('path');
const Module = require('module');
const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') {
    return {
      SymbolKind: { Function: 11, Method: 5, Constructor: 8 },
      CompletionItemKind: { Function: 3 },
      workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
      commands: { executeCommand: async () => [] },
      Uri: { file: (value) => ({ fsPath: value }) },
      CompletionItem: class { constructor(label, kind) { this.label = label; this.kind = kind; } },
      MarkdownString: class { constructor(value) { this.value = value; } }
    };
  }
  return originalLoad.apply(this, arguments);
};
const { normalizeRuntimePath } = require(path.join(root, 'out', 'utils', 'pathUtils.js'));
const { scanCFunctions, CviSymbolService } = require(path.join(root, 'out', 'services', 'cviSymbolService.js'));
const manifestViews = pkg.contributes.views.labwindowsCvi.map((item) => item.id);
const titleActions = pkg.contributes.menus['view/title']
  .filter((item) => item.when === 'view == labwindowsCvi.quickActions')
  .map((item) => item.command);
const source = `
static int helper(int x) { return x; }
int CVICALLBACK check_lg2(int panel, int event, void *data, int d1, int d2) { return 0; }
void Update(void);
int __stdcall WinMain(HINSTANCE hInstance, HINSTANCE previous, LPSTR command, int show) { return 0; }
`;
const scanned = scanCFunctions(source, 'demo.c').map((item) => item.name);
const symbols = new CviSymbolService(root, { activeProjectRef: undefined });
const completionCount = symbols.completionSymbols().length;
const buildSource = fs.readFileSync(path.join(root, 'src', 'services', 'cviBuildService.ts'), 'utf8');
const extensionSource = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
const result = {
  status: 'ok',
  version: pkg.version,
  publisher: pkg.publisher,
  runtimePathNormalization: {
    cviDrive: normalizeRuntimePath('/c/PROG_CVI/EXE/Test.exe'),
    cygdrive: normalizeRuntimePath('/cygdrive/d/tools/app.exe')
  },
  quickActionsTitleToolbar: {
    count: titleActions.length,
    commands: titleActions
  },
  fileSymbolsView: manifestViews.includes('labwindowsCvi.fileSymbols'),
  supplementalCompletionSetting: pkg.contributes.configuration.properties['labwindowsCvi.enableSupplementalCompletionProvider']?.default,
  supplementalCompletionRegistration: extensionSource.includes('registerCompletionItemProvider'),
  bundledCompletionSymbols: completionCount,
  scannedFunctions: scanned,
  runPathNormalizationHook: buildSource.includes('normalizeRuntimePath(rawExecutablePath)') && buildSource.includes('useExternalHost')
};
const failures = [];
if (pkg.version !== '0.5.8') failures.push('version');
if (!result.fileSymbolsView) failures.push('fileSymbolsView');
if (titleActions.length < 8) failures.push('quickActionsTitleToolbar');
if (result.runtimePathNormalization.cviDrive !== 'C:\\PROG_CVI\\EXE\\Test.exe') failures.push('cviPathNormalization');
if (!['helper','check_lg2','Update','WinMain'].every((name) => scanned.includes(name))) failures.push('functionScanner');
if (completionCount < 1900) failures.push('bundledCompletionSymbols');
if (!result.runPathNormalizationHook) failures.push('runPathNormalizationHook');
if (result.supplementalCompletionSetting !== true) failures.push('supplementalCompletionSetting');
if (!result.supplementalCompletionRegistration) failures.push('supplementalCompletionRegistration');
if (failures.length) {
  result.status = 'error';
  result.failures = failures;
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}
fs.writeFileSync(path.join(root, 'PATH_COMPLETION_SYMBOLS_0.5.8_VALIDATION.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
