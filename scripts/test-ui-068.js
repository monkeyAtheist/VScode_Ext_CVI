const assert = require('assert');
const path = require('path');
const root = path.resolve(__dirname, '..');
const { BuildSettingsPanel } = require(path.join(root, 'out/views/buildSettingsPanel.js'));

const ref = { name: 'DemoDll', exists: true, absolutePath: path.join(root, 'DemoDll.prj'), index: 1 };
function nativeTarget(overrides = {}) {
  return {
    targetType: 'Dynamic Link Library', outputPath: 'DemoDll.dll', applicationTitle: '', iconFile: '',
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
  const settings = { getSettings: () => ({ preBuildActions:[],customBuildActions:[],postBuildActions:[],dependencies:[],run:{arguments:'',workingDirectory:'',environmentOptions:'',externalProcessPath:''} }) };
  const workspaces = { activeProjectRef: ref, getProject: () => ({ files: [] }), currentWorkspace: { projects:[ref] } };
  return new BuildSettingsPanel(workspaces, parser, settings).render(ref);
}
const html = render();
assert(html.includes('id="typeLibraryResourceBlock"'));
assert(html.includes('id="niTypeInfoResourceBlock"'));
assert(html.includes('id="addTypeLibToDll"'));
assert(html.includes('id="includeTypeLibHelpLinks"'));
assert(html.includes('<option value="HLP" selected>HLP</option>'));
assert(html.includes('<option value="CHM" >CHM</option>'));
assert(html.includes('id="addNiTypeInfoToDll"'));
assert(html.includes('id="niTypeInfoFromAllSources"'));
assert(html.includes('id="niTypeInfoFromSingleHeader"'));
assert(html.includes('id="singleHeaderNiTypeInfoRow"'));
assert(html.includes("const updateDllTypeInformationControls=()=>"));
assert(html.includes("disableField('includeTypeLibHelpLinks',!typeLibEnabled)"));
assert(html.includes("disableField('tlbHelpStyle',!helpLinksEnabled)"));
assert(html.includes("headerRow.classList.toggle('hidden',!singleHeader)"));
assert(html.includes("useSingleHeaderForNiTypeInfo:flag('niTypeInfoFromSingleHeader')"));
assert(!html.includes('id="useSingleHeaderForNiTypeInfo" type="checkbox"'));
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
new Function(script);
const pkg = require(path.join(root, 'package.json'));
assert.equal(pkg.version, '0.6.8');
console.log('0.6.8 DLL type-information conditional UI validation OK');
