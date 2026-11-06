'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const service = fs.readFileSync(path.join(root,'src/services/cviNativeCommandService.ts'),'utf8');
const dde = fs.readFileSync(path.join(root,'native/cvi-dde-command.ps1'),'utf8');
const ax = fs.readFileSync(path.join(root,'native/cvi-activex-command.ps1'),'utf8');
const windowCtl = fs.readFileSync(path.join(root,'native/cvi-window-control.ps1'),'utf8');
const background = fs.readFileSync(path.join(root,'native/cvi-start-background.ps1'),'utf8');
const parserSource = fs.readFileSync(path.join(root,'src/model/cviParser.ts'),'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const arch = fs.readFileSync(path.join(root,'ARCHITECTURE.md'),'utf8');

let passed=0, failed=0;
async function test(name, fn){try{await fn();passed++;console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+': '+(e.stack||e));}}

(async()=>{
  await test('package version includes v0.7.37 native-debug fixes',()=>assert(/^0\.7\.(?:3[7-9]|[4-9]\d)$/.test(pkg.version)));
  await test('DDE bridge accepts an exact target process ID',()=>assert(dde.includes('[int]$TargetProcessId = 0')));
  await test('DDE enumerates all matching servers instead of DdeConnect-only selection',()=>{assert(dde.includes('DdeConnectList'));assert(dde.includes('DdeQueryNextServer'));});
  await test('DDE identifies server process through CONVINFO partner window',()=>{assert(dde.includes('DdeQueryConvInfo'));assert(dde.includes('hwndPartner'));assert(dde.includes('GetWindowThreadProcessId'));});
  await test('untargeted multi-instance DDE connection is explicitly refused',()=>assert(dde.includes('Refusing an ambiguous connection')));
  await test('DDE payload reports selected and candidate process IDs',()=>{assert(dde.includes('serverProcessId'));assert(dde.includes('candidateProcessIds'));});
  await test('persistent DDE session is started with TargetProcessId',()=>assert(service.includes("'-TargetProcessId', String(targetProcessId), '-Session'")));
  await test('one-shot DDE probes carry TargetProcessId',()=>assert(service.includes("args.push('-TargetProcessId', String(targetProcessId))")));
  await test('natural-completion polling remains bound to same CVI PID',()=>assert(service.includes("invokeDde(COMMANDS.state, '', this.nativeServerProcessId)")));
  await test('background launcher returns CVI PID',()=>assert(background.includes('pid = $process.Id')));
  await test('standard launcher retains child PID',()=>assert(service.includes('const pid = child.pid')));
  await test('window control requires a single process ID',()=>{assert(windowCtl.includes('[int]$ProcessId = 0'));assert(windowCtl.includes('Get-Process -Id $ProcessId'));assert(!windowCtl.includes("Get-Process -Name 'cvi'"));});
  await test('window control receives bound CVI PID',()=>assert(service.includes("'-ProcessId', String(processId)")));
  await test('ActiveX bridge refuses ambiguous multiple CVI processes',()=>assert(ax.includes('Multiple LabWindows/CVI processes are running')));
  await test('ActiveX bridge verifies expected bound PID',()=>{assert(ax.includes('[int]$ExpectedProcessId = 0'));assert(service.includes("'-ExpectedProcessId', String(this.nativeServerProcessId)"));});
  await test('multi-project workspace refuses unverified existing-instance reuse',()=>assert(service.includes('Existing CVI PID ${pid} is not reused for a multi-project workspace')));
  await test('existing single-instance reuse requires matching native window title',()=>assert(service.includes('title.includes(candidate)')));
  await test('context switch is blocked while previous native execution is active',()=>assert(service.includes('Stop that execution before building or running another CVI context')));
  await test('persistent session can be re-established after bridge loss',()=>assert(service.includes('Re-established the persistent DDE control session for PID')));
  await test('Build blocks while CVI waits for modal response',()=>assert(service.includes('Cannot build while LabWindows/CVI is waiting for a modal dialog response')));
  await test('Run blocks while CVI waits for modal response',()=>assert(service.includes('Cannot start native execution while LabWindows/CVI is waiting for a modal dialog response')));
  await test('bridge failure updates dashboard result rather than leaving false connection',()=>{assert(service.includes("this.serverAvailable = undefined"));assert(service.includes("this.lastResult = error"));});
  await test('dead inline DAP polling settings are removed',()=>{assert(!pkg.contributes.configuration.properties['labwindowsCvi.nativeDapPollIntervalMs']);assert(!pkg.contributes.configuration.properties['labwindowsCvi.nativeDapPollTimeoutMs']);});
  await test('dead DAP monitor methods are removed from native service',()=>{assert(!service.includes('startDebugAdapterMonitoring'));assert(!service.includes('pollDebugAdapterState'));});
  await test('extension does not register a debugger contribution',()=>assert(!pkg.contributes.debuggers));
  await test('architecture documents removed DAP facade instead of claiming it is current',()=>{assert(arch.includes('inline DAP prototype from 0.6.24 was removed in 0.6.30'));assert(!arch.includes('src/debug/cviNativeDebugAdapter.ts'));});
  await test('breakpoint synchronization uses mutation snapshot',()=>{
    const pos=parserSource.indexOf('synchronizeWorkspaceBreakpoints('); const tail=parserSource.slice(pos,pos+7000);
    assert(tail.includes('const snapshot = readTextForMutation(workspacePath)'));
    assert(tail.includes('writeText(workspacePath, document.toString(), snapshot.buffer)'));
  });

  // Runtime regression for the new breakpoint write guard: mutate the .cws on the
  // second read (the guarded write's revision check) and ensure the external save wins.
  const { CviParser } = require('../out/model/cviParser.js');
  const parser = new CviParser();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'cvi0737-bp-'));
  const created = parser.createWorkspaceAndProject(temp,'Dbg','App','Executable',undefined,2000);
  const source = path.join(temp,'main.c'); fs.writeFileSync(source,'int main(void){return 0;}\n');
  parser.addFilesToProject(created.projectPath,[source]);
  const originalRead=fs.readFileSync, originalWrite=fs.writeFileSync;
  let cwsReads=0;
  fs.readFileSync=function(file,...args){
    if(path.resolve(String(file))===path.resolve(created.workspacePath)){
      cwsReads++;
      if(cwsReads===2){
        const current=originalRead.call(fs,file,'utf8');
        originalWrite.call(fs,file,current+'\n; external CVI save during breakpoint sync\n','utf8');
      }
    }
    return originalRead.call(fs,file,...args);
  };
  try{
    await test('concurrent native save cancels breakpoint write and preserves external bytes',()=>{
      assert.throws(()=>parser.synchronizeWorkspaceBreakpoints(created.workspacePath,1,created.projectPath,[{filePath:source,line:1}],[],false),/changed on disk/i);
      const after=originalRead.call(fs,created.workspacePath,'utf8');
      assert(after.includes('; external CVI save during breakpoint sync'));
    });
  } finally { fs.readFileSync=originalRead; }

  console.log(`RESULT ${passed} passed, ${failed} failed`);
  if(failed) process.exitCode=1;
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
