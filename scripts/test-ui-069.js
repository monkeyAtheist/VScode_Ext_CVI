const assert = require('assert');
const path = require('path');
const root = path.resolve(__dirname, '..');
const { BuildSettingsPanel } = require(path.join(root, 'out/views/buildSettingsPanel.js'));

const ref = { name: 'DemoDll', exists: true, absolutePath: path.join(root, 'DemoDll.prj'), index: 1 };
function nativeTarget(overrides = {}) {
  return {
    targetType: 'Dynamic Link Library', outputPath: 'DemoDll.dll', applicationTitle: '', iconFile: '',
    runtimeSupport: 'Full Runtime Support', runtimeBinding: 'Shared', generateSourceDocumentation: 'None',
    manifestEmbed: false, manifestPath: 'demo.manifest', embedProjectUirs: false, generateMapFile: false,
    createConsoleApplication: false, embedTimestamp: false, usingLoadExternalModule: false,
    forcedModules: [], useDefaultImportLibBaseName: true, importLibBaseName: 'DemoDll', whereToCopyDll: 'Do not copy',
    customDirectoryToCopyDll: 'C:/tmp', useIviSubdirectoriesForImportLibraries: true,
    useVxiPnpSubdirectoriesForImportLibraries: false, dllExports: 'Symbols Marked As Export', exportFiles: [],
    addTypeLibToDll: false, includeTypeLibHelpLinks: false, tlbHelpStyle: 'HLP', typeLibFpFile: '',
    addNiTypeInfoToDll: false, useSingleHeaderForNiTypeInfo: false, singleHeaderNiTypeInfoFile: '',
    versionInfo: { numericFileVersion:'1,0,0,0',numericProductVersion:'1,0,0,0',comments:'',companyName:'',fileDescription:'',fileVersion:'',internalName:'',legalCopyright:'',legalTrademarks:'',originalFilename:'',privateBuild:'',productName:'',productVersion:'',specialBuild:'' },
    signing: { enabled:false, store:'', certificate:'', timestampUrl:'', descriptionUrl:'', signDebugBuild:false },
    ...overrides
  };
}
function render(overrides) {
  const parser = { getNativeTargetSettings: () => nativeTarget(overrides) };
  const settings = { getSettings: () => ({ preBuildActions:[],customBuildActions:[],postBuildActions:[],dependencies:[],run:{arguments:'',workingDirectory:'',environmentOptions:'',externalProcessPath:''} }) };
  const workspaces = { activeProjectRef: ref, getProject: () => ({ files: [{ type: 'Include', relativePath: 'Source File.h', absolutePath: path.join(root, 'Source File.h') }] }), currentWorkspace: { projects:[ref] } };
  return new BuildSettingsPanel(workspaces, parser, settings).render(ref);
}
const html = render();
assert(html.includes('id="manifestPathRow"'));
assert(html.includes('id="importLibBaseNameRow"'));
assert(html.includes('id="customDirectoryToCopyDllRow"'));
assert(html.includes('id="dllExportHeadersBlock"'));
assert(html.includes('id="openImportLibraryChoices"'));
assert(html.includes('id="importLibraryChoicesDialog"'));
assert(html.includes('id="useIviSubdirectoriesForImportLibraries"'));
assert(html.includes('id="useVxiPnpSubdirectoriesForImportLibraries"'));
assert(html.includes("const updateTargetCreationControls=()=>"));
assert(html.includes("const updateDllOptionControls=()=>"));
assert(html.includes("disableField('manifestPath',!manifestEnabled)"));
assert(html.includes("disableField('importLibBaseName',useDefault)"));
assert(html.includes("val('whereToCopyDll')==='Custom directory'"));
assert(html.includes("val('dllExports')!=='Symbols Marked As Export'"));
assert(html.includes("for(const input of document.querySelectorAll('[data-export-file]'))input.disabled=!headersEnabled"));
assert(html.includes("el('manifestEmbed')?.addEventListener('change',updateTargetCreationControls)"));
assert(html.includes("el('whereToCopyDll')?.addEventListener('change',updateDllOptionControls)"));
assert(html.includes("el('dllExports')?.addEventListener('change',updateDllOptionControls)"));
assert(html.includes('DLL Import Library Choices'));
assert(html.indexOf('id="openImportLibraryChoices"') < html.indexOf('id="importLibraryChoicesDialog"'));
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
new Function(script);
const pkg = require(path.join(root, 'package.json'));
assert.equal(pkg.version, '0.6.9');
console.log('0.6.9 DLL conditional target-settings UI validation OK');
