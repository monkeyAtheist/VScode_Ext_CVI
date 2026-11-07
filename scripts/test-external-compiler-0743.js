'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
process.env.NODE_PATH = path.join(__dirname, '..', 'test-mocks');
Module._initPaths();

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const buildSource = fs.readFileSync(path.join(root, 'src', 'services', 'cviBuildService.ts'), 'utf8');
const panelSource = fs.readFileSync(path.join(root, 'src', 'views', 'buildSettingsPanel.ts'), 'utf8');
const extSource = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
const settingsSource = fs.readFileSync(path.join(root, 'src', 'services', 'cviProjectSettingsService.ts'), 'utf8');
const { parseCviDefineOptions, splitWindowsArguments, CviBuildService } = require('../out/services/cviBuildService');
const { CviProjectSettingsService } = require('../out/services/cviProjectSettingsService');

let passed=0, failed=0;
function test(name, fn){ try { const r=fn(); if(r&&typeof r.then==='function') return r.then(()=>{passed++;console.log('PASS '+name);}).catch(e=>{failed++;console.error('FAIL '+name+': '+(e.stack||e));}); passed++; console.log('PASS '+name);} catch(e){failed++;console.error('FAIL '+name+': '+(e.stack||e));}}

function output(){ return {appendLine(){},append(){},clear(){},show(){}}; }
function diag(){return {clear(){},set(){}};}

(async()=>{
await test('package version keeps v0.7.43+ external compiler support',()=>assert(Number(pkg.version.split('.')[2])>=43));
await test('project settings model exposes native CVI and MSVC build engines',()=>{
  assert(settingsSource.includes("export type CviBuildEngine = 'cvi' | 'msvc'"));
  assert(settingsSource.includes('externalBuild: CviExternalBuildSettings'));
});
await test('legacy projects default to native CVI engine',()=>assert(settingsSource.includes("engine: value?.engine === 'msvc' ? 'msvc' : 'cvi'")));
await test('visual settings contains dedicated External Compiler page',()=>{
  assert(panelSource.includes("{ id: 'external', label: 'External Compiler'"));
  assert(panelSource.includes('data-settings-page="external"'));
});
await test('visual settings selects native or MSVC engine',()=>{
  assert(panelSource.includes("['cvi','Native LabWindows/CVI (compile.exe)']"));
  assert(panelSource.includes("['msvc','External Microsoft Visual C++ (MSVC)']"));
});
await test('visual settings exposes vcvars, build directory, compiler/link options and extra libraries',()=>{
  for(const id of ['externalVcvarsallPath','externalBuildDirectory','externalCompilerOptions','externalLinkerOptions','externalLibraries']) assert(panelSource.includes(id));
});
await test('visual settings exposes CVI support files and VS Code debug switches',()=>{
  assert(panelSource.includes('externalUseCviSupport'));
  assert(panelSource.includes('externalDebugVsCode'));
});
await test('save payload persists external compiler settings',()=>{
  assert(panelSource.includes("externalBuild:{engine:val('externalBuildEngine')"));
  assert(panelSource.includes("additionalLibraries:lines('externalLibraries')"));
});
await test('commands expose selected-engine build and external VS Code debug',()=>{
  assert(pkg.contributes.commands.some(c=>c.command==='labwindowsCvi.externalBuild'));
  assert(pkg.contributes.commands.some(c=>c.command==='labwindowsCvi.externalDebug'));
  assert(extSource.includes("register('labwindowsCvi.externalDebug'"));
});
await test('native debug preflight explicitly forces native CVI build',()=>{
  assert(extSource.includes('await builds.buildNative(false)'));
  assert(buildSource.includes("return await this.build(rebuild, projectRef, 'cvi')"));
});
await test('CVI define parser converts /D entries generically',()=>{
  assert.deepStrictEqual(parseCviDefineOptions('/DFOO /DBAR=3 /D"NAME=hello world"'),['FOO','BAR=3','NAME=hello world']);
});
await test('Windows option parser preserves quoted option payloads',()=>{
  assert.deepStrictEqual(splitWindowsArguments('/DTEST /I"C:\\Program Files\\SDK" /wd4996'),['/DTEST','/IC:\\Program Files\\SDK','/wd4996']);
});
await test('external build resolves CVI msvc/msvc64 support folders',()=>{
  assert(buildSource.includes("path.join(installation.root, 'extlib', is64 ? 'msvc64' : 'msvc')"));
  assert(buildSource.includes("'cvirt.lib'"));
  assert(buildSource.includes("'cvisupp.lib'"));
});
await test('external build uses UIR callbacks and project symbols only when generated',()=>{
  assert(buildSource.includes('getExternalCompilerSupportSettings'));
  assert(buildSource.includes('support.uirCallbacksObjFile'));
  assert(buildSource.includes('support.projectSymbolsObjFile'));
});
await test('external build warns about mandatory InitCVIRTE and CloseCVIRTE',()=>{
  assert(buildSource.includes('InitCVIRTE'));
  assert(buildSource.includes('CloseCVIRTE'));
});
await test('debug MSVC builds generate PDB information',()=>{
  assert(buildSource.includes("debug ? '/Z7'"));
  assert(buildSource.includes("'/DEBUG', `/PDB:${pdb}`"));
});
await test('VS Code external debugger uses cppvsdbg',()=>{
  assert(buildSource.includes("type: 'cppvsdbg'"));
  assert(buildSource.includes('debugWithExternalCompiler'));
});
await test('external compiler page explains external build does not enable CVI debugger',()=>{
  assert(panelSource.includes('external compiler does not make the binary debuggable by the CVI debugger'));
});
await test('MSVC environment is auto-discovered with vswhere or explicit vcvarsall',()=>{
  assert(buildSource.includes('vswhere.exe'));
  assert(buildSource.includes('vcvarsall.bat'));
});
await test('clean removes extension-managed external build directory',()=>{
  assert(buildSource.includes('Deleted external build directory'));
  assert(buildSource.includes("'cvi-external-build'"));
});
await test('external Debug warns about CVI Debug static-library compatibility',()=>{
  assert(buildSource.includes('static libraries created by CVI in a Debug configuration are not supported outside LabWindows/CVI'));
});
await test('External Compiler page displays native generated support file status',()=>{
  assert(panelSource.includes('Native CVI External Compiler Support metadata'));
  assert(panelSource.includes('UIR callback file:'));
  assert(panelSource.includes('Project symbols object:'));
});
await test('external build refuses missing source/object/library inputs instead of silently skipping them',()=>{
  assert(buildSource.includes('C source file(s) are missing'));
  assert(buildSource.includes('object/library input(s) are missing'));
});
await test('external build remains generic and contains no project-specific API names',()=>{
  assert(!/SeqApi|hReturn_|MCO_ACS/.test(buildSource+panelSource+settingsSource));
});

console.log(`RESULT ${passed} passed, ${failed} failed`); if(failed) process.exitCode=1;
})();
