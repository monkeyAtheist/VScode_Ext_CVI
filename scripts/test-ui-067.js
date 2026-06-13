const assert = require('assert');
const path = require('path');
const root = path.resolve(__dirname, '..');
const { BuildSettingsPanel } = require(path.join(root, 'out/views/buildSettingsPanel.js'));

const ref = { name: 'Demo', exists: true, absolutePath: path.join(root, 'Demo.prj'), index: 1 };
function nativeTarget(runtimeSupport = 'Full Runtime Support') {
  return {
    targetType: 'Executable', outputPath: 'Demo.exe', applicationTitle: 'Demo', iconFile: '',
    runtimeSupport, runtimeBinding: 'Shared', generateSourceDocumentation: 'None',
    manifestEmbed: false, manifestPath: '', embedProjectUirs: false, generateMapFile: false,
    createConsoleApplication: false, embedTimestamp: false, usingLoadExternalModule: true,
    forcedModules: ['advanlys.lib', 'toolbox.obj'], useDefaultImportLibBaseName: true,
    importLibBaseName: '', whereToCopyDll: 'Do not copy', customDirectoryToCopyDll: '',
    useIviSubdirectoriesForImportLibraries: false, useVxiPnpSubdirectoriesForImportLibraries: false,
    dllExports: 'Include File Symbols', exportFiles: [], addTypeLibToDll: false,
    includeTypeLibHelpLinks: false, tlbHelpStyle: 'HLP', typeLibFpFile: '', addNiTypeInfoToDll: false,
    useSingleHeaderForNiTypeInfo: false, singleHeaderNiTypeInfoFile: '',
    versionInfo: { numericFileVersion:'1,0,0,0',numericProductVersion:'1,0,0,0',comments:'',companyName:'',fileDescription:'',fileVersion:'',internalName:'',legalCopyright:'',legalTrademarks:'',originalFilename:'',privateBuild:'',productName:'',productVersion:'',specialBuild:'' },
    signing: { enabled:false, store:'', certificate:'', timestampUrl:'', descriptionUrl:'', signDebugBuild:false }
  };
}
function render(runtimeSupport) {
  const parser = { getNativeTargetSettings: () => nativeTarget(runtimeSupport) };
  const settings = { getSettings: () => ({ preBuildActions:[],customBuildActions:[],postBuildActions:[],dependencies:[],run:{arguments:'',workingDirectory:'',environmentOptions:'',externalProcessPath:''} }) };
  const workspaces = { activeProjectRef: ref, getProject: () => ({ files: [] }), currentWorkspace: { projects:[ref] } };
  return new BuildSettingsPanel(workspaces, parser, settings).render(ref);
}
const html = render('Instrument Driver Support Only');
assert(html.includes('<section class="card wide"><details open><summary>Target</summary>'));
assert(html.includes('<section class="card wide"><details open><summary>Project dependencies and build order</summary>'));
assert(html.includes('id="loadExternalModuleSection"'));
assert(html.includes('Unavailable when run-time support is set to Instrument driver only.'));
assert(html.includes("const isInstrumentDriverOnly=()=>val('runtimeSupport')==='Instrument Driver Support Only'"));
assert(html.includes("el('runtimeSupport')?.addEventListener('change',updateForcedModuleControls);"));
assert(html.includes("zone.classList.toggle('disabled-zone',unavailable)"));
assert(html.includes("el('usingLoadExternalModule').disabled=unavailable"));
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
new Function(script);
const pkg = require(path.join(root, 'package.json'));
assert.equal(pkg.version, '0.6.7');
console.log('0.6.7 stacked sections and Instrument Driver Support guard validation OK');
