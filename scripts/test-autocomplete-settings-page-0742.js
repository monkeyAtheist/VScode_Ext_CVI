'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const panel = fs.readFileSync(path.join(root, 'src', 'views', 'buildSettingsPanel.ts'), 'utf8');
const symbols = fs.readFileSync(path.join(root, 'src', 'services', 'cviSymbolService.ts'), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + ': ' + (e.stack || e)); }
}

test('package version includes v0.7.42 settings page', () => assert(/^0\.7\.(?:4[2-9]|[5-9]\d|\d{3,})$/.test(pkg.version)));
test('project settings navigation contains a dedicated Autocompletion page', () => {
  assert(panel.includes("{ id: 'autocomplete', label: 'Autocompletion'"));
  assert(panel.includes('data-settings-page="autocomplete"'));
});
test('visual page exposes all five generic profiles', () => {
  for (const value of ['hybrid', 'native', 'nativeSignature', 'cviApi', 'custom']) {
    assert(panel.includes(`['${value}'`));
  }
});
test('visual page exposes the four Custom switches', () => {
  for (const id of ['autocompleteCompletionEnabled','autocompleteProjectSymbols','autocompleteCviApi','autocompleteSignatureHelp']) {
    assert(panel.includes(`id="${id}"`));
  }
});
test('Custom switches are disabled visually outside Custom mode', () => {
  assert(panel.includes("input.disabled=!custom"));
  assert(panel.includes("customHost.style.opacity=custom?'1':'.62'"));
});
test('visual page displays an effective-behavior preview', () => {
  assert(panel.includes('id="autocompleteEffective"'));
  assert(panel.includes('CVI PM completion: '));
  assert(panel.includes('Project symbols: '));
  assert(panel.includes('Signature Help: '));
});
test('visual page recommends Native plus CVI Signature Help for duplicate-free completion', () => {
  assert(panel.includes('Native + CVI Signature Help'));
  assert(panel.includes('avoids duplicate project completion entries'));
});
test('visual page includes IntelliSense sync and diagnostics actions', () => {
  assert(panel.includes('data-command="labwindowsCvi.syncCppTools"'));
  assert(panel.includes('data-command="labwindowsCvi.diagnoseCppTools"'));
});
test('normal Save payload includes autocomplete settings', () => {
  assert(panel.includes("autocomplete:{profile:val('autocompleteProfile')"));
  assert(panel.includes("includeProjectCompletion:flag('autocompleteProjectSymbols')"));
  assert(panel.includes("signatureHelpEnabled:flag('autocompleteSignatureHelp')"));
});
test('project settings save persists autocomplete configuration at workspace scope', () => {
  assert(panel.includes("config.update('autocompleteProfile', profile, target)"));
  assert(panel.includes("config.update('enableSupplementalCompletionProvider'"));
  assert(panel.includes("config.update('enableSupplementalProjectCompletion'"));
  assert(panel.includes("config.update('enableSupplementalCviApiCompletion'"));
  assert(panel.includes("config.update('enableSupplementalSignatureHelp'"));
  assert(panel.includes('const target = vscode.ConfigurationTarget.Workspace'));
});
test('visual page uses the same runtime profile resolver as completion providers', () => {
  assert(panel.includes('getCviAutocompleteSettings()'));
  assert(symbols.includes('export function getCviAutocompleteSettings()'));
});
test('visual profile management does not rewrite Microsoft C/C++ settings', () => {
  const start = panel.indexOf('private async saveAutocompleteSettings');
  const end = panel.indexOf('private applyNativeTargetSettings', start);
  assert(start >= 0 && end > start);
  const fn = panel.slice(start, end);
  assert(!/C_Cpp|intelliSenseEngine|configurationProvider/.test(fn));
});
test('autocomplete settings are explicitly described as workspace-level and build-mode independent', () => {
  assert(panel.includes('apply to the current VS Code workspace'));
  assert(panel.includes('independent from the selected CVI Debug/Release configuration'));
});
test('visual page remains generic and has no project/library-specific runtime rule', () => {
  const runtime = panel + '\n' + symbols;
  assert(!/SeqApi|hReturn_|SEQ_API/.test(runtime));
});

console.log(`RESULT ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
