const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const { BuildSettingsPanel } = require(path.join(root, 'out/views/buildSettingsPanel.js'));

const ref = { name: 'Demo', exists: true, absolutePath: path.join(root, 'Demo.prj'), index: 1 };
const parser = {
  getNativeTargetSettings: () => ({
    targetType: 'Dynamic Link Library', outputPath: 'Demo.dll', applicationTitle: '', iconFile: '',
    runtimeSupport: 'Full Runtime Support', runtimeBinding: 'Shared', generateSourceDocumentation: 'None',
    manifestEmbed: false, manifestPath: '', embedProjectUirs: false, generateMapFile: false,
    createConsoleApplication: false, embedTimestamp: true, usingLoadExternalModule: true,
    forcedModules: ['advanlys.lib', 'toolbox.obj'], useDefaultImportLibBaseName: true,
    importLibBaseName: '', whereToCopyDll: 'Do not copy', customDirectoryToCopyDll: '',
    useIviSubdirectoriesForImportLibraries: false, useVxiPnpSubdirectoriesForImportLibraries: false,
    dllExports: 'Include File Symbols', exportFiles: [], addTypeLibToDll: false,
    includeTypeLibHelpLinks: false, tlbHelpStyle: 'HLP', typeLibFpFile: '', addNiTypeInfoToDll: false,
    useSingleHeaderForNiTypeInfo: false, singleHeaderNiTypeInfoFile: '',
    versionInfo: { numericFileVersion:'1,0,0,0',numericProductVersion:'1,0,0,0',comments:'',companyName:'',fileDescription:'',fileVersion:'',internalName:'',legalCopyright:'',legalTrademarks:'',originalFilename:'',privateBuild:'',productName:'',productVersion:'',specialBuild:'' },
    signing: { enabled:false, store:'', certificate:'', timestampUrl:'', descriptionUrl:'', signDebugBuild:false }
  })
};
const settings = { getSettings: () => ({ preBuildActions:[],customBuildActions:[],postBuildActions:[],dependencies:[],run:{arguments:'',workingDirectory:'',environmentOptions:'',externalProcessPath:''} }) };
const workspaces = { activeProjectRef: ref, getProject: () => ({ files: [] }), currentWorkspace: { projects:[ref] } };
const panel = new BuildSettingsPanel(workspaces, parser, settings);
const html = panel.render(ref);
assert(html.includes('<summary>Target</summary>'));
assert(html.includes('<summary>LoadExternalModule options</summary>'));
assert(html.includes('<summary>Build steps</summary>'));
assert(html.includes('id="addForcedModules"'));
assert(html.includes('id="forcedModulesPreview"'));
assert(html.includes('Add files to ${target.targetType') === false, 'rendered HTML must resolve target label');
assert(html.includes('Add files to DLL'));
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
new Function(script);

const pkg = require(path.join(root, 'package.json'));
assert.equal(pkg.version, '0.6.6');
assert(pkg.contributes.submenus.some((x) => x.id === 'labwindowsCvi.convertSelectedInteger'));
assert(pkg.contributes.menus['editor/context'].some((x) => x.submenu === 'labwindowsCvi.convertSelectedInteger' && x.when === 'editorHasSelection'));

function convert(literal, target) {
  const match = literal.match(/^([+-]?)(0[xX][0-9a-fA-F]+|0[bB][01]+|[0-9]+)([uUlL]*)$/);
  if (!match) return undefined;
  const [, sign, digits, suffix] = match;
  const unsignedDigits = digits.replace(/^0[xX]/, '').replace(/^0[bB]/, '');
  const base = /^0[xX]/.test(digits) ? 16 : /^0[bB]/.test(digits) ? 2 : 10;
  const value = BigInt(base === 16 ? `0x${unsignedDigits}` : base === 2 ? `0b${unsignedDigits}` : unsignedDigits);
  const body = target === 'hexadecimal' ? `0x${value.toString(16).toUpperCase()}` : target === 'binary' ? `0b${value.toString(2)}` : value.toString(10);
  return `${sign}${body}${suffix}`;
}
assert.equal(convert('42', 'hexadecimal'), '0x2A');
assert.equal(convert('0x2A', 'binary'), '0b101010');
assert.equal(convert('-0b101010U', 'decimal'), '-42U');
assert.equal(convert('not-a-number', 'decimal'), undefined);
console.log('UI and integer conversion validation OK');
