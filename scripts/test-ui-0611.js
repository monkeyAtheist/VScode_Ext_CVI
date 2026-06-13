const assert = require('assert');
const path = require('path');
const root = path.resolve(__dirname, '..');
const { BuildSettingsPanel } = require(path.join(root, 'out/views/buildSettingsPanel.js'));

const ref = { name: 'Demo', exists: true, absolutePath: path.join(root, 'Demo.prj'), index: 1 };
function nativeTarget(overrides = {}) {
  return {
    targetType: 'Executable', outputPath: 'Demo.exe', applicationTitle: '', iconFile: '',
    runtimeSupport: 'Full Runtime Support', runtimeBinding: 'Shared', generateSourceDocumentation: 'None',
    manifestEmbed: false, manifestPath: '', embedProjectUirs: false, generateMapFile: false,
    createConsoleApplication: false, embedTimestamp: false, usingLoadExternalModule: false,
    forcedModules: [], useDefaultImportLibBaseName: true, importLibBaseName: '', whereToCopyDll: 'Do not copy',
    customDirectoryToCopyDll: '', useIviSubdirectoriesForImportLibraries: false,
    useVxiPnpSubdirectoriesForImportLibraries: false, dllExports: 'Include File Symbols', exportFiles: [],
    addTypeLibToDll: false, includeTypeLibHelpLinks: false, tlbHelpStyle: 'HLP', typeLibFpFile: '',
    addNiTypeInfoToDll: false, useSingleHeaderForNiTypeInfo: false, singleHeaderNiTypeInfoFile: '',
    versionInfo: { numericFileVersion:'1,0,0,0',numericProductVersion:'1,0,0,0',comments:'',companyName:'',fileDescription:'',fileVersion:'',internalName:'',legalCopyright:'',legalTrademarks:'',originalFilename:'',privateBuild:'',productName:'',productVersion:'',specialBuild:'' },
    signing: { enabled:false, store:'', certificate:'', timestampUrl:'', descriptionUrl:'', signDebugBuild:false },
    ...overrides
  };
}
function render(overrides) {
  const parser = { getNativeTargetSettings: () => nativeTarget(overrides) };
  const settings = { getSettings: () => ({ preBuildActions:[],customBuildActions:[],postBuildActions:[],dependencies:[],run:{arguments:'',workingDirectory:'',environmentOptions:'',externalProcessPath:'C:/runner.exe'} }) };
  const workspaces = { activeProjectRef: ref, getProject: () => ({ files: [] }), currentWorkspace: { projects:[ref] } };
  return new BuildSettingsPanel(workspaces, parser, settings).render(ref);
}
const exe = render({ targetType:'Executable' });
assert(exe.includes('id="signingDetailsBlock"'));
assert(exe.includes('id="externalProcessPathRow"'));
assert(exe.includes('class="card wide target-nonlib"><details open><summary>Executable command line'));
assert(exe.includes("const updateSigningControls=()=>"));
assert(exe.includes("disableField('externalProcessPath',!dll)"));
assert(exe.includes("el('signEnabled')?.addEventListener('change',updateSigningControls)"));
assert(exe.includes('updateSigningControls();updateExecutableCommandLineControls();'));
const script = exe.match(/<script>([\s\S]*?)<\/script>/)[1];
new Function(script);
const lib = render({ targetType:'Static Library' });
assert(lib.includes('target-nonlib'));
assert(lib.includes('Executable command line'));
assert(lib.includes('body:not([data-target="Static Library"]) .target-nonlib{display:block}'));
const pkg = require(path.join(root, 'package.json'));
assert.equal(pkg.version, '0.6.11');
assert(pkg.contributes.commands.some((entry) => entry.command === 'labwindowsCvi.openFunctionPanel'));
assert(pkg.activationEvents.includes('onCommand:labwindowsCvi.openFunctionPanel'));
console.log('0.6.11 conditional signing/run UI validation OK');
