const fs = require('fs');
const os = require('os');
const path = require('path');
const { CviParser } = require('../out/model/cviParser');

const sourceProject = process.argv[2] || '/mnt/data/CVI_src/CVI/DLL/Source File.prj';
if (!fs.existsSync(sourceProject)) throw new Error(`Missing test project: ${sourceProject}`);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cvi064-'));
const project = path.join(root, 'Source File.prj');
fs.copyFileSync(sourceProject, project);
const parser = new CviParser();
const modes = ['debug', 'release', 'debug64', 'release64'];
const base = parser.getNativeTargetSettings(project, 'debug');
base.applicationTitle = 'ALL_CONFIG_TITLE';
base.runtimeSupport = 'Instrument Driver Support Only';
base.runtimeBinding = 'Side-by-side';
base.generateSourceDocumentation = 'XML & HTML';
base.manifestPath = path.join(root, 'sample.manifest');
base.outputPath = path.join(root, 'all-config-output.dll');
for (const mode of modes) parser.setNativeTargetSettings(project, mode, base);
const reread = Object.fromEntries(modes.map(mode => [mode, parser.getNativeTargetSettings(project, mode)]));
for (const mode of modes) {
  const value = reread[mode];
  if (value.applicationTitle !== base.applicationTitle) throw new Error(`${mode}: applicationTitle mismatch`);
  if (value.runtimeSupport !== base.runtimeSupport) throw new Error(`${mode}: runtimeSupport mismatch`);
  if (value.runtimeBinding !== base.runtimeBinding) throw new Error(`${mode}: runtimeBinding mismatch`);
  if (value.generateSourceDocumentation !== base.generateSourceDocumentation) throw new Error(`${mode}: generateSourceDocumentation mismatch`);
  if (!value.outputPath.endsWith('all-config-output.dll')) throw new Error(`${mode}: output mismatch ${value.outputPath}`);
}
const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'buildSettingsPanel.ts'), 'utf8');
const expected = [
  'data-browse-field="${escapeHtml(id)}"',
  'Configuration scope<select id="configurationScope">',
  "All Configurations",
  "Full run-time engine",
  "Instrument driver only",
  "Side-by-side for entire application",
  "Side-by-side for executable only",
  "Generate help from source",
  "Where to copy DLL",
  "Export mode"
];
for (const marker of expected) if (!panel.includes(marker)) throw new Error(`Missing UI marker: ${marker}`);
const result = {
  version: require('../package.json').version,
  status: 'ok',
  modes: Object.fromEntries(modes.map(mode => [mode, {
    title: reread[mode].applicationTitle,
    runtimeSupport: reread[mode].runtimeSupport,
    runtimeBinding: reread[mode].runtimeBinding,
    help: reread[mode].generateSourceDocumentation,
    output: reread[mode].outputPath
  }])),
  browserFields: ['outputPath','iconFile','manifestPath','customDirectoryToCopyDll','typeLibFpFile','singleHeaderNiTypeInfoFile','workingDirectory','externalProcessPath'],
  scopes: ['debug','release','debug64','release64','all'],
  selectLists: ['runtimeSupport','runtimeBinding','generateSourceDocumentation','whereToCopyDll','dllExports']
};
console.log(JSON.stringify(result, null, 2));
