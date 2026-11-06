'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvi0735-'));
const root = path.join(temp, 'workspace');
fs.mkdirSync(root, { recursive: true });
let settings = { buildMode: 'debug', customBuildConfiguration: '', autoConfigureCppTools: true, autoAddCviFolderToWorkspace: false, additionalIncludePaths: [], intelliSenseCompilerPath: '' };
const logs = [];
const vscodeMock = {
  workspace: {
    getConfiguration: () => ({ get:(k,f)=>Object.prototype.hasOwnProperty.call(settings,k)?settings[k]:f, update:async(k,v)=>{settings[k]=v;}, inspect:()=>undefined }),
    workspaceFolders:[{uri:{fsPath:root},name:'workspace'}], getWorkspaceFolder:()=>({uri:{fsPath:root},name:'workspace'})
  },
  Uri:{file:(fsPath)=>({scheme:'file',fsPath:path.resolve(fsPath)})},
  window:{showErrorMessage:async()=>undefined,showWarningMessage:async()=>undefined,showInformationMessage:async()=>undefined,activeTextEditor:undefined},
  extensions:{getExtension:()=>undefined}, ConfigurationTarget:{Global:1,Workspace:2,WorkspaceFolder:3}, commands:{executeCommand:async()=>undefined}
};
const originalLoad=Module._load; Module._load=function(req,p,i){if(req==='vscode')return vscodeMock;return originalLoad.call(this,req,p,i);};
const { CviParser } = require('../out/model/cviParser.js');
const { CviCppToolsService } = require('../out/services/cviCppToolsService.js');
const { CviBuildService } = require('../out/services/cviBuildService.js');
const parser = new CviParser();
let passed=0, failed=0;
async function test(name,fn){try{await fn();passed++;console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+': '+(e.stack||e));}}
function insertCustomConfig(projectPath){
  let s=fs.readFileSync(projectPath,'utf8');
  s=s.replace(/(\[Custom Build Configs\][\s\S]*?Num Custom Build Configs\s*=\s*)0/i,'$11');
  s += `\n[Arbitrary Native Section 9001]\nConfig Name = "QA x64"\nIs 64-Bit = True\nIs Release = False\nDefault Calling Convention = "cdecl"\nRequire Prototypes = True\nRequire Return Values = True\nEnable C99 Extensions = False\nCompiler Defines = "/DQA_BUILD /DQA_LEVEL=735"\nStack Size = 250000\nImage Base Address = 4194304\nImage Base Address x64 = 4194304\n`;
  fs.writeFileSync(projectPath,s,'utf8');
}
(async()=>{
  const created=parser.createWorkspaceAndProject(root,'AuditWS','Audit','Executable','C:\\Program Files (x86)\\National Instruments\\CVI2013',1302);
  const c=path.join(root,'main.c'), h=path.join(root,'main.h'), u=path.join(root,'main.uir'), lib=path.join(root,'support.lib');
  fs.writeFileSync(c,'int main(void){return 0;}'); fs.writeFileSync(h,'#pragma once'); fs.writeFileSync(u,''); fs.writeFileSync(lib,'');
  parser.addFilesToProject(created.projectPath,[c,h,u,lib]);
  let project=parser.parseProject(created.projectPath);
  const byExt=e=>project.files.find(f=>path.extname(f.absolutePath).toLowerCase()===e);
  await test('C source is eligible for Exclude File from Build',()=>assert.strictEqual(byExt('.c').excludeEligible,true));
  await test('library is eligible for Exclude File from Build',()=>assert.strictEqual(byExt('.lib').excludeEligible,true));
  await test('header is not eligible for Exclude File from Build',()=>assert.strictEqual(byExt('.h').excludeEligible,false));
  await test('UIR is not eligible for Exclude File from Build',()=>assert.strictEqual(byExt('.uir').excludeEligible,false));
  await test('excluding a header is rejected without changing project bytes',()=>{const before=fs.readFileSync(created.projectPath);assert.throws(()=>parser.setFileExcluded(created.projectPath,byExt('.h').sectionName,true),/not applicable/i);assert.deepStrictEqual(fs.readFileSync(created.projectPath),before);});
  await test('C source Exclude round trips',()=>{parser.setFileExcluded(created.projectPath,byExt('.c').sectionName,true);project=parser.parseProject(created.projectPath);assert.strictEqual(project.files.find(f=>f.absolutePath===c).excluded,true);});
  await test('Compile Into Object File remains C-source only',()=>{const src=project.files.find(f=>f.absolutePath===c);parser.setCompileIntoObjectFile(created.projectPath,src.sectionName,true);assert.strictEqual(parser.parseProject(created.projectPath).files.find(f=>f.absolutePath===c).compileIntoObjectFile,true);assert.throws(()=>parser.setCompileIntoObjectFile(created.projectPath,project.files.find(f=>f.absolutePath===h).sectionName,true),/C source/i);});
  await test('file metadata exposes Project Flags and Path Force Path Absolute',()=>{const f=parser.parseProject(created.projectPath).files.find(f=>f.absolutePath===c);assert.strictEqual(typeof f.projectFlags,'number');assert.strictEqual(typeof f.pathForceAbsolute,'boolean');});
  await test('External Compiler Support native section is parsed without rewriting it',()=>{const before=fs.readFileSync(created.projectPath);const ext=parser.getExternalCompilerSupportSettings(created.projectPath);assert.strictEqual(typeof ext.usingLoadExternalModule,'boolean');assert.strictEqual(typeof ext.createProjectSymbolsFile,'boolean');assert.deepStrictEqual(fs.readFileSync(created.projectPath),before);});

  insertCustomConfig(created.projectPath);
  await test('custom configuration count read from native Custom Build Configs section',()=>assert.strictEqual(parser.getDeclaredCustomBuildConfigurationCount(created.projectPath),1));
  await test('custom configuration detected without depending on section name',()=>{const cfg=parser.getNativeBuildConfiguration(created.projectPath,'QA x64');assert(cfg);assert.strictEqual(cfg.sectionName,'Arbitrary Native Section 9001');assert.strictEqual(cfg.isCustom,true);assert.strictEqual(cfg.is64Bit,true);assert.strictEqual(cfg.isRelease,false);});
  await test('custom compiler defines are deserialized',()=>{const c=parser.getNativeCompilerSettingsForConfiguration(created.projectPath,'QA x64');assert(c);assert(c.compilerDefines.includes('/DQA_BUILD'));assert.strictEqual(c.enableC99Extensions,false);});
  await test('custom configuration inspection has no serialization warning when recognized',()=>{const issues=parser.inspectNativeCompilerConfigurationForConfiguration(created.projectPath,'QA x64','debug64');assert(!issues.some(i=>/not found|serialized/i.test(i.message)));});
  await test('workspace stores exact custom build configuration name',()=>{parser.setWorkspaceProjectBuildConfiguration(created.workspacePath,1,'QA x64');assert.strictEqual(parser.getWorkspaceProjectBuildConfiguration(created.workspacePath,1),'QA x64');assert.strictEqual(parser.getWorkspaceProjectBuildMode(created.workspacePath,1),undefined);});

  await test('build service automatically honors custom configuration stored in .cws',()=>{
    const ref=parser.parseWorkspace(created.workspacePath).projects[0];
    const wsMock={ activeProjectRef:ref, getProjectBuildMode:()=>undefined, getProjectBuildConfiguration:()=> 'QA x64' };
    const noop={appendLine:()=>{},append:()=>{},clear:()=>{},show:()=>{}};
    const svc=new CviBuildService(parser,wsMock,{getActiveInstallation:()=>undefined},{},{},noop,noop,{clear:()=>{},set:()=>{}});
    assert.strictEqual(svc.resolveCustomBuildConfiguration(ref),'QA x64');
    assert.strictEqual(svc.modeForConfiguration(created.projectPath,'QA x64','debug'),'debug64');
    assert.deepStrictEqual(svc.commonCompilerArguments(false,'debug64','QA x64'),['-config=QA x64']);
  });

  await test('native debugger accepts a recognized custom Debug configuration',async()=>{
    const ref=parser.parseWorkspace(created.workspacePath).projects[0];
    const wsMock={ activeProjectRef:ref, getProjectBuildMode:()=>undefined, getProjectBuildConfiguration:()=> 'QA x64' };
    const noop={appendLine:()=>{},append:()=>{},clear:()=>{},show:()=>{}};
    const svc=new CviBuildService(parser,wsMock,{getActiveInstallation:()=>undefined},{},{},noop,noop,{clear:()=>{},set:()=>{}});
    assert.strictEqual(await svc.ensureDebugBuildMode(ref),true);
  });

  const install={root:path.join(temp,'CVI2013'),label:'CVI2013',clangCcExe:'',source:'configured'}; fs.mkdirSync(path.join(install.root,'include'),{recursive:true});
  const service=new CviCppToolsService({getActiveInstallation:()=>install},parser,{appendLine:l=>logs.push(String(l)),show:()=>{}});
  const ws=parser.parseWorkspace(created.workspacePath);
  await service.sync(ws,false);
  const doc=JSON.parse(fs.readFileSync(path.join(root,'.vscode','c_cpp_properties.json'),'utf8'));
  const managed=doc.configurations.find(c=>c.name==='LabWindows/CVI (managed)');
  await test('IntelliSense uses custom configuration x64 architecture',()=>assert.strictEqual(managed.intelliSenseMode,'windows-clang-x64'));
  await test('IntelliSense uses custom configuration defines',()=>{assert(managed.defines.includes('QA_BUILD'));assert(managed.defines.includes('QA_LEVEL=735'));});
  await test('IntelliSense uses custom configuration C standard',()=>assert.strictEqual(managed.cStandard,'c89'));
  await test('custom configuration name macro is exact',()=>assert(managed.defines.includes('_CVI_CONFIGURATION_NAME_="QA x64"')));
  await test('recognized custom config does not emit fallback limitation',()=>assert(!logs.some(l=>l.includes('QA x64')&&l.includes('not safely recognized'))));

  // Mismatch between declared count and discovered sections is advisory, not destructive.
  let text=fs.readFileSync(created.projectPath,'utf8').replace(/(Num Custom Build Configs\s*=\s*)1/i,'$12'); fs.writeFileSync(created.projectPath,text,'utf8');
  await test('declared/discovered custom-config mismatch is reported as warning',()=>assert(parser.inspectNativeCompilerConfigurationForConfiguration(created.projectPath,'QA x64','debug64').some(i=>i.field==='Custom Build Configurations')));

  console.log(`RESULT ${passed} passed, ${failed} failed`); if(failed)process.exitCode=1;
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
