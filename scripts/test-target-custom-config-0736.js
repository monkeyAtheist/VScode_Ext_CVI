'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvi0736-'));
const root = path.join(temp, 'workspace');
fs.mkdirSync(root, { recursive: true });
const outputLines = [];
const vscodeMock = {
  workspace: { workspaceFolders:[{uri:{fsPath:root},name:'workspace'}], getConfiguration:()=>({get:(k,f)=>f,update:async()=>{}}) },
  window:{}, Uri:{file:(fsPath)=>({fsPath})}, ConfigurationTarget:{Workspace:2}
};
const originalLoad=Module._load; Module._load=function(req,p,i){if(req==='vscode')return vscodeMock;return originalLoad.call(this,req,p,i);};
const { CviParser } = require('../out/model/cviParser.js');
const { CviProjectSettingsService } = require('../out/services/cviProjectSettingsService.js');
const parser = new CviParser();
let passed=0, failed=0;
async function test(name,fn){try{await fn();passed++;console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+': '+(e.stack||e));}}
function addCustomProjectConfig(projectPath){
  let s=fs.readFileSync(projectPath,'utf8');
  s=s.replace(/(\[Custom Build Configs\][\s\S]*?Num Custom Build Configs\s*=\s*)0/i,'$11');
  s += `\n[Native Custom Target 9001]\nConfig Name = "QA x64"\nIs 64-Bit = True\nIs Release = False\nDefault Calling Convention = "cdecl"\nRequire Prototypes = True\nRequire Return Values = True\nEnable C99 Extensions = True\nCompiler Defines = "/DQA_OLD"\nApplication Title = "QA old"\nRuntime Support = "Full Runtime Support"\nRuntime Binding = "Shared"\nGenerate Source Documentation = "None"\nManifest Embed = False\nEmbed Project .UIRs = False\nGenerate Map File = False\nCreate Console Application = False\nEmbed Timestamp = True\nUsing LoadExternalModule = False\nUse Dflt Import Lib Base Name = True\nWhere to Copy DLL = "Do not copy"\nDLL Exports = "Include File Symbols"\nAdd Type Lib To DLL = False\nInclude Type Lib Help Links = False\nTLB Help Style = "HLP"\nAdd NI Type Info To DLL = False\nUse Single Header for NI Type Info = False\nNumeric File Version = "1,0,0,0"\nNumeric Prod Version = "1,0,0,0"\nSign = False\n`;
  fs.writeFileSync(projectPath,s,'utf8');
}
function addCustomWorkspaceConfig(workspacePath){
  let s=fs.readFileSync(workspacePath,'utf8');
  s += `\n[Default Build Config 0001 QA x64]\nGenerate Browse Info = True\nEnable Uninitialized Locals Runtime Warning = True\nBatch Build = False\nProfile = "Disabled"\nDebugging Level = "Standard"\nExecution Trace = "Disabled"\nCommand Line Args = "--qa-old"\nWorking Directory = ""\nEnvironment Options = "QA=OLD"\nExternal Process Path = ""\n`;
  fs.writeFileSync(workspacePath,s,'utf8');
}
(async()=>{
  const created=parser.createWorkspaceAndProject(root,'AuditWS','Audit','Dynamic Link Library','C:\\Program Files (x86)\\National Instruments\\CVI2013',1302);
  addCustomProjectConfig(created.projectPath);
  parser.setWorkspaceProjectBuildConfiguration(created.workspacePath,1,'QA x64');
  const descriptor=parser.getNativeBuildConfiguration(created.projectPath,'QA x64');
  await test('recognized custom target configuration descriptor',()=>{assert(descriptor);assert.strictEqual(descriptor.is64Bit,true);assert.strictEqual(descriptor.isRelease,false);});
  await test('custom target initially falls back to standard output when exact output is absent',()=>{const t=parser.getNativeTargetSettingsForConfiguration(created.projectPath,'QA x64','debug64');assert(t);assert(t.outputPath.toLowerCase().endsWith('.dll'));});
  const standardBefore=parser.getNativeTargetSettings(created.projectPath,'debug64');
  const custom=parser.getNativeTargetSettingsForConfiguration(created.projectPath,'QA x64','debug64');
  custom.outputPath=path.join(root,'qa output','Audit-QA.dll');
  custom.applicationTitle='Audit QA x64';
  custom.runtimeBinding='Side-by-side';
  custom.manifestEmbed=true;
  custom.manifestPath=path.join(root,'audit.manifest');
  custom.generateMapFile=true;
  custom.embedProjectUirs=true;
  custom.useDefaultImportLibBaseName=false;
  custom.dllImportLibraryChoice='Gen Lib For Current Mode';
  custom.importLibBaseName='AuditQAImport';
  custom.whereToCopyDll='Custom directory';
  custom.customDirectoryToCopyDll=path.join(root,'qa dll copy');
  custom.dllExports='Symbols Marked As Export';
  custom.exportFiles=['audit_api.h'];
  custom.versionInfo.companyName='QA Company';
  custom.versionInfo.productVersion='7.36';
  custom.signing.enabled=true;
  custom.signing.store='CurrentUser';
  custom.signing.certificate='QA Certificate';
  parser.setNativeTargetSettingsForConfiguration(created.projectPath,'QA x64',custom);
  await test('custom output path round trips under exact configuration name',()=>assert.strictEqual(parser.getTargetPathForConfiguration(created.projectPath,'QA x64','debug64'),custom.outputPath));
  await test('Create Executable stores exact Executable File_QA x64 key',()=>assert(/Executable File_QA x64(?: Is Rel|\s*=)/i.test(fs.readFileSync(created.projectPath,'utf8'))));
  await test('custom application title and runtime binding round trip',()=>{const t=parser.getNativeTargetSettingsForConfiguration(created.projectPath,'QA x64','debug64');assert.strictEqual(t.applicationTitle,'Audit QA x64');assert.strictEqual(t.runtimeBinding,'Side-by-side');});
  await test('custom manifest and map settings round trip',()=>{const t=parser.getNativeTargetSettingsForConfiguration(created.projectPath,'QA x64','debug64');assert.strictEqual(t.manifestEmbed,true);assert.strictEqual(t.manifestPath,custom.manifestPath);assert.strictEqual(t.generateMapFile,true);});
  await test('custom DLL import/export settings round trip',()=>{const t=parser.getNativeTargetSettingsForConfiguration(created.projectPath,'QA x64','debug64');assert.strictEqual(t.useDefaultImportLibBaseName,false);assert.strictEqual(t.importLibBaseName,'AuditQAImport');assert.strictEqual(t.whereToCopyDll,'Custom directory');assert.strictEqual(t.customDirectoryToCopyDll,custom.customDirectoryToCopyDll);assert.strictEqual(t.dllExports,'Symbols Marked As Export');assert.deepStrictEqual(t.exportFiles,['audit_api.h']);});
  await test('custom DLL import library choice is preserved without enum coercion',()=>{const t=parser.getNativeTargetSettingsForConfiguration(created.projectPath,'QA x64','debug64');assert.strictEqual(t.dllImportLibraryChoice,'Gen Lib For Current Mode');assert(/DLL Import Library Choice\s*=\s*"Gen Lib For Current Mode"/i.test(fs.readFileSync(created.projectPath,'utf8')));});
  await test('custom version/signing settings round trip',()=>{const t=parser.getNativeTargetSettingsForConfiguration(created.projectPath,'QA x64','debug64');assert.strictEqual(t.versionInfo.companyName,'QA Company');assert.strictEqual(t.versionInfo.productVersion,'7.36');assert.strictEqual(t.signing.enabled,true);assert.strictEqual(t.signing.certificate,'QA Certificate');});
  await test('standard Debug64 target remains isolated from custom per-config values',()=>{const t=parser.getNativeTargetSettings(created.projectPath,'debug64');assert.strictEqual(t.applicationTitle,standardBefore.applicationTitle);assert.notStrictEqual(t.outputPath,custom.outputPath);});
  const compiler=parser.getNativeCompilerSettingsForConfiguration(created.projectPath,'QA x64');
  compiler.compilerDefines='/DQA_NEW /DQA_LEVEL=736'; compiler.enableC99Extensions=false;
  parser.setNativeCompilerSettingsForConfiguration(created.projectPath,'QA x64',compiler);
  await test('custom compiler settings are writable without touching standard mode',()=>{const c=parser.getNativeCompilerSettingsForConfiguration(created.projectPath,'QA x64');assert(c.compilerDefines.includes('/DQA_NEW'));assert.strictEqual(c.enableC99Extensions,false);assert(!parser.getNativeCompilerSettings(created.projectPath,'debug64').compilerDefines.includes('/DQA_NEW'));});
  await test('unknown custom target setter is rejected byte-identically',()=>{const before=fs.readFileSync(created.projectPath);assert.throws(()=>parser.setNativeTargetSettingsForConfiguration(created.projectPath,'DOES_NOT_EXIST',custom),/not found/i);assert.deepStrictEqual(fs.readFileSync(created.projectPath),before);});
  await test('custom workspace run/build settings are absent until CVI serialized a matching section',()=>{assert.strictEqual(parser.hasWorkspaceBuildConfigurationSection(created.workspacePath,1,'QA x64'),false);assert.strictEqual(parser.getWorkspaceRunOptionsForConfiguration(created.workspacePath,1,'QA x64'),undefined);});
  await test('refusing unsafely invented custom workspace run section leaves bytes unchanged',()=>{const before=fs.readFileSync(created.workspacePath);assert.throws(()=>parser.setWorkspaceRunOptionsForConfiguration(created.workspacePath,1,'QA x64',{arguments:'--x',workingDirectory:'',environmentOptions:'',externalProcessPath:''}),/does not contain/i);assert.deepStrictEqual(fs.readFileSync(created.workspacePath),before);});
  addCustomWorkspaceConfig(created.workspacePath);
  await test('existing custom workspace section is detected',()=>assert.strictEqual(parser.hasWorkspaceBuildConfigurationSection(created.workspacePath,1,'QA x64'),true));
  await test('custom run settings read exact native section',()=>{const r=parser.getWorkspaceRunOptionsForConfiguration(created.workspacePath,1,'QA x64');assert.strictEqual(r.arguments,'--qa-old');assert.strictEqual(r.environmentOptions,'QA=OLD');});
  parser.setWorkspaceRunOptionsForConfiguration(created.workspacePath,1,'QA x64',{arguments:'--qa-new 736',workingDirectory:path.join(root,'run qa'),environmentOptions:'QA=NEW;LEVEL=736',externalProcessPath:path.join(root,'host.exe')});
  await test('custom run settings round trip independently',()=>{const r=parser.getWorkspaceRunOptionsForConfiguration(created.workspacePath,1,'QA x64');assert.strictEqual(r.arguments,'--qa-new 736');assert(r.workingDirectory.includes('run qa'));assert.strictEqual(r.environmentOptions,'QA=NEW;LEVEL=736');assert(r.externalProcessPath.toLowerCase().endsWith('host.exe'));});
  await test('standard workspace run settings remain isolated',()=>assert.notStrictEqual(parser.getWorkspaceRunOptions(created.workspacePath,1,'debug64').arguments,'--qa-new 736'));
  let wb=parser.getWorkspaceNativeBuildOptionsForConfiguration(created.workspacePath,1,'QA x64'); wb.debuggingLevel='Extended'; wb.executionTrace='Enabled'; wb.batchBuild=true;
  parser.setWorkspaceNativeBuildOptionsForConfiguration(created.workspacePath,1,'QA x64',wb);
  await test('custom workspace build/debug options round trip',()=>{const x=parser.getWorkspaceNativeBuildOptionsForConfiguration(created.workspacePath,1,'QA x64');assert.strictEqual(x.debuggingLevel,'Extended');assert.strictEqual(x.executionTrace,'Enabled');assert.strictEqual(x.batchBuild,true);});
  const ref=parser.parseWorkspace(created.workspacePath).projects[0];
  const wsService={currentWorkspace:parser.parseWorkspace(created.workspacePath),getProjectBuildMode:()=>undefined};
  const projectSettings=new CviProjectSettingsService(wsService,parser,{appendLine:(x)=>outputLines.push(x)});
  await test('project settings service resolves custom run settings for execution',()=>{const x=projectSettings.getSettingsForConfiguration(ref,'QA x64','debug64');assert.strictEqual(x.run.arguments,'--qa-new 736');assert.strictEqual(x.nativeBuildActions,true);});
  await test('custom metadata update preserves native custom build steps ownership',()=>{const x=projectSettings.getSettingsForConfiguration(ref,'QA x64','debug64');x.dependencies=[];x.run.arguments='--qa-service';projectSettings.setCustomConfigurationMetadata(ref,'QA x64',x,true);assert.strictEqual(parser.getWorkspaceRunOptionsForConfiguration(created.workspacePath,1,'QA x64').arguments,'--qa-service');});
  await test('target reader falls back to Create Executable global metadata when custom field is omitted',()=>{let text=fs.readFileSync(created.projectPath,'utf8');text=text.replace(/(\[Native Custom Target 9001\][\s\S]*?)Application Title\s*=.*\r?\n/,'$1');fs.writeFileSync(created.projectPath,text,'utf8');const t=parser.getNativeTargetSettingsForConfiguration(created.projectPath,'QA x64','debug64');assert.strictEqual(typeof t.applicationTitle,'string');});
  await test('custom target API does not rewrite configuration section name',()=>assert(fs.readFileSync(created.projectPath,'utf8').includes('[Native Custom Target 9001]')));
  await test('custom configuration output path with spaces remains parseable after mutation',()=>{const t=parser.getNativeTargetSettingsForConfiguration(created.projectPath,'QA x64','debug64');assert(t.outputPath.includes('Audit-QA.dll'));});
  console.log(`RESULT ${passed} passed, ${failed} failed`); if(failed)process.exitCode=1;
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
