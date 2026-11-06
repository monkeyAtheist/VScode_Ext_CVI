'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const state = { config: {}, explicit: new Set() };
class Position { constructor(line, character){ this.line=line; this.character=character; } }
class Range { constructor(start, end){ this.start=start; this.end=end; } }
class MarkdownString { constructor(value){ this.value=value; } }
class SignatureHelp { constructor(){ this.signatures=[]; this.activeSignature=0; this.activeParameter=0; } }
class SignatureInformation { constructor(label, documentation){ this.label=label; this.documentation=documentation; this.parameters=[]; } }
class ParameterInformation { constructor(label, documentation){ this.label=label; this.documentation=documentation; } }
class CompletionItem { constructor(label, kind){ this.label=label; this.kind=kind; } }
const vscodeMock = {
  SymbolKind: { Function: 11, Method: 5, Constructor: 8 },
  CompletionItemKind: { Function: 3 },
  workspace: {
    getConfiguration: () => ({
      get: (key, fallback) => Object.prototype.hasOwnProperty.call(state.config,key) ? state.config[key] : fallback,
      inspect: (key) => ({ key, defaultValue: undefined, workspaceValue: state.explicit.has(key) ? state.config[key] : undefined })
    })
  },
  Position, Range, MarkdownString, SignatureHelp, SignatureInformation, ParameterInformation, CompletionItem
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain){ if(request==='vscode') return vscodeMock; return originalLoad.call(this, request, parent, isMain); };

const {
  CviSymbolService,
  CviSignatureHelpProvider,
  CviCompletionProvider,
  resolveAutocompleteProfile,
  getCviAutocompleteSettings
} = require('../out/services/cviSymbolService.js');
const pkg = require('../package.json');

let passed=0, failed=0;
async function test(name, fn){ try { await fn(); passed++; console.log('PASS '+name); } catch(e){ failed++; console.error('FAIL '+name+': '+(e.stack||e)); } }
function setProfile(profile){ state.config.autocompleteProfile=profile; state.explicit.add('autocompleteProfile'); }
function clearProfile(){ delete state.config.autocompleteProfile; state.explicit.delete('autocompleteProfile'); }
function documentFor(text, filePath){
  return {
    uri: { scheme:'file', fsPath:filePath },
    getText(range){
      if(!range) return text;
      const lines=text.split('\n');
      const offset=(pos)=>{ let n=0; for(let i=0;i<pos.line;i++) n+=lines[i].length+1; return n+pos.character; };
      return text.slice(offset(range.start), offset(range.end));
    }
  };
}

(async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cvi0741-autocomplete-'));
  const header=path.join(root,'ExampleApi.h');
  fs.writeFileSync(header, 'int Driver_Init(const char *resource, int flags);\n', 'utf8');
  const projectPath=path.join(root,'Test.prj'); fs.writeFileSync(projectPath,'','utf8');
  const workspacePath=path.join(root,'Test.cws'); fs.writeFileSync(workspacePath,'','utf8');
  const ref={exists:true,absolutePath:projectPath};
  const workspaces={currentWorkspace:{path:workspacePath,projects:[ref]},activeProjectRef:ref,getProject:(candidate)=>candidate===ref?{files:[{absolutePath:header}]}:undefined};
  const symbols=new CviSymbolService(path.resolve(__dirname,'..'),workspaces);
  const completion=new CviCompletionProvider(symbols);
  const signature=new CviSignatureHelpProvider(symbols);
  const doc=documentFor('Driver_Init(',header);

  await test('package version keeps v0.7.41+ autocomplete profiles',()=>assert(/^0\.7\.(?:4[1-9]|[5-9]\d|\d{3,})$/.test(pkg.version)));
  await test('manifest exposes autocomplete profile with Hybrid default',()=>{
    const setting=pkg.contributes.configuration.properties['labwindowsCvi.autocompleteProfile'];
    assert(setting); assert.strictEqual(setting.default,'hybrid');
    assert.deepStrictEqual(setting.enum,['hybrid','native','nativeSignature','cviApi','custom']);
  });
  await test('manifest exposes custom CVI API completion switch',()=>assert.strictEqual(pkg.contributes.configuration.properties['labwindowsCvi.enableSupplementalCviApiCompletion'].default,true));
  await test('Hybrid profile enables all CVI PM assistance',()=>assert.deepStrictEqual(resolveAutocompleteProfile('hybrid'),{profile:'hybrid',completionEnabled:true,includeProjectCompletion:true,includeCviApiCompletion:true,signatureHelpEnabled:true}));
  await test('Native profile disables CVI PM completion and signature help',()=>assert.deepStrictEqual(resolveAutocompleteProfile('native'),{profile:'native',completionEnabled:false,includeProjectCompletion:false,includeCviApiCompletion:false,signatureHelpEnabled:false}));
  await test('Native + Signature profile keeps only CVI PM parameter help',()=>assert.deepStrictEqual(resolveAutocompleteProfile('nativeSignature'),{profile:'nativeSignature',completionEnabled:false,includeProjectCompletion:false,includeCviApiCompletion:false,signatureHelpEnabled:true}));
  await test('CVI API profile excludes project completion',()=>assert.deepStrictEqual(resolveAutocompleteProfile('cviApi'),{profile:'cviApi',completionEnabled:true,includeProjectCompletion:false,includeCviApiCompletion:true,signatureHelpEnabled:true}));
  await test('Custom profile honors every advanced switch',()=>assert.deepStrictEqual(resolveAutocompleteProfile('custom',{completionEnabled:true,includeProjectCompletion:false,includeCviApiCompletion:false,signatureHelpEnabled:false}),{profile:'custom',completionEnabled:true,includeProjectCompletion:false,includeCviApiCompletion:false,signatureHelpEnabled:false}));

  await test('Hybrid provider includes project symbol',()=>{ setProfile('hybrid'); const items=completion.provideCompletionItems(doc)||[]; assert(items.some(x=>x.label==='Driver_Init')); });
  await test('Hybrid provider includes embedded CVI API symbol',()=>{ setProfile('hybrid'); const items=completion.provideCompletionItems(doc)||[]; assert(items.some(x=>x.label==='MessagePopup')); });
  await test('Native profile withdraws CVI PM completion provider',()=>{ setProfile('native'); assert.strictEqual(completion.provideCompletionItems(doc),undefined); });
  await test('Native profile withdraws CVI PM signature help',()=>{ setProfile('native'); assert.strictEqual(signature.provideSignatureHelp(doc,new Position(0,'Driver_Init('.length)),undefined); });
  await test('Native + Signature profile withdraws completion but keeps parameters',()=>{ setProfile('nativeSignature'); assert.strictEqual(completion.provideCompletionItems(doc),undefined); const help=signature.provideSignatureHelp(doc,new Position(0,'Driver_Init('.length)); assert(help); assert.strictEqual(help.signatures[0].parameters.length,2); });
  await test('CVI API Assist hides project completion but keeps CVI API completion',()=>{ setProfile('cviApi'); const items=completion.provideCompletionItems(doc)||[]; assert(!items.some(x=>x.label==='Driver_Init')); assert(items.some(x=>x.label==='MessagePopup')); });
  await test('CVI API Assist still provides immediate project signature help',()=>{ setProfile('cviApi'); const help=signature.provideSignatureHelp(doc,new Position(0,'Driver_Init('.length)); assert(help); assert.strictEqual(help.signatures[0].parameters.length,2); });

  await test('Custom profile can select project-only completion',()=>{
    setProfile('custom'); Object.assign(state.config,{enableSupplementalCompletionProvider:true,enableSupplementalProjectCompletion:true,enableSupplementalCviApiCompletion:false,enableSupplementalSignatureHelp:true});
    const items=completion.provideCompletionItems(doc)||[]; assert(items.some(x=>x.label==='Driver_Init')); assert(!items.some(x=>x.label==='MessagePopup'));
  });
  await test('Custom profile can disable only Signature Help',()=>{ setProfile('custom'); state.config.enableSupplementalSignatureHelp=false; assert.strictEqual(signature.provideSignatureHelp(doc,new Position(0,'Driver_Init('.length)),undefined); state.config.enableSupplementalSignatureHelp=true; });
  await test('legacy explicit boolean settings fall back to Custom when no profile was chosen',()=>{
    clearProfile(); state.config.enableSupplementalProjectCompletion=false; state.explicit.add('enableSupplementalProjectCompletion');
    const resolved=getCviAutocompleteSettings(); assert.strictEqual(resolved.profile,'custom'); assert.strictEqual(resolved.includeProjectCompletion,false);
    state.explicit.delete('enableSupplementalProjectCompletion'); state.config.enableSupplementalProjectCompletion=true;
  });
  await test('profile selection takes priority over legacy custom switches once explicitly chosen',()=>{
    setProfile('hybrid'); state.config.enableSupplementalCompletionProvider=false; state.explicit.add('enableSupplementalCompletionProvider');
    const resolved=getCviAutocompleteSettings(); assert.strictEqual(resolved.profile,'hybrid'); assert.strictEqual(resolved.completionEnabled,true);
    state.explicit.delete('enableSupplementalCompletionProvider'); state.config.enableSupplementalCompletionProvider=true;
  });
  await test('extension contributes and registers profile selector command',()=>{
    assert(pkg.contributes.commands.some(x=>x.command==='labwindowsCvi.selectAutocompleteProfile'));
    const source=fs.readFileSync(path.join(__dirname,'..','src','extension.ts'),'utf8');
    assert(source.includes("register('labwindowsCvi.selectAutocompleteProfile'"));
    assert(source.includes("config.update('autocompleteProfile'"));
  });
  await test('profile selector never rewrites Microsoft C/C++ provider settings',()=>{
    const source=fs.readFileSync(path.join(__dirname,'..','src','extension.ts'),'utf8');
    const start=source.indexOf('const selectAutocompleteProfile');
    const end=source.indexOf('const focusTreeThen',start);
    const fn=source.slice(start,end);
    assert(!/C_Cpp|intelliSenseEngine|configurationProvider/.test(fn));
  });
  await test('runtime implementation contains no project-specific SeqApi or hReturn rules',()=>{
    const src=fs.readFileSync(path.join(__dirname,'..','src','services','cviSymbolService.ts'),'utf8');
    assert(!/SeqApi|hReturn_|SEQ_API/.test(src));
  });

  console.log(`RESULT ${passed} passed, ${failed} failed`);
  if(failed) process.exitCode=1;
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
