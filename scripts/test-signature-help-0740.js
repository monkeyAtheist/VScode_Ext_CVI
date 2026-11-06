'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const state = { config: {} };
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
  workspace: { getConfiguration: () => ({ get: (key, fallback) => Object.prototype.hasOwnProperty.call(state.config,key) ? state.config[key] : fallback }) },
  Position, Range, MarkdownString, SignatureHelp, SignatureInformation, ParameterInformation, CompletionItem
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain){ if(request==='vscode') return vscodeMock; return originalLoad.call(this, request, parent, isMain); };

const {
  CviSymbolService,
  CviSignatureHelpProvider,
  CviCompletionProvider,
  extractSignatureParameters,
  findCviCallContext
} = require('../out/services/cviSymbolService.js');
const pkg = require('../package.json');

let passed=0, failed=0;
async function test(name, fn){ try { await fn(); passed++; console.log('PASS '+name); } catch(e){ failed++; console.error('FAIL '+name+': '+(e.stack||e)); } }

function documentFor(text, filePath){
  return {
    uri: { scheme:'file', fsPath:filePath },
    getText(range){
      if(!range) return text;
      const lines=text.split('\n');
      const offset=(pos)=>{
        let n=0; for(let i=0;i<pos.line;i++) n+=lines[i].length+1; return n+pos.character;
      };
      return text.slice(offset(range.start), offset(range.end));
    }
  };
}

(async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cvi0740-signature-'));
  const header=path.join(root,'SeqApi.h');
  const sourceFile=path.join(root,'SeqApi.c');
  fs.writeFileSync(header, `
#define SEQ_API __declspec(dllimport)
SEQ_API int hReturn_Fail(void);
SEQ_API int hReturn_Meas(short Type, double Value, short Digits, double Min, double Max, char *Unit, char *Message, short *Success);
SEQ_API void SeqApi_Init_EventCallback(void (*callback)(int, void *, void *));
int overload(int value);
int overload(double value, int flags);
`, 'utf8');
  fs.writeFileSync(sourceFile, `
int hReturn_Meas(short Type, double Value, short Digits, double Min, double Max, char *Unit, char *Message, short *Success) { return 0; }
`, 'utf8');
  const projectPath=path.join(root,'Test.prj'); fs.writeFileSync(projectPath,'', 'utf8');
  const workspacePath=path.join(root,'Test.cws'); fs.writeFileSync(workspacePath,'', 'utf8');
  const ref={ exists:true, absolutePath:projectPath };
  const project={ files:[{absolutePath:sourceFile},{absolutePath:header}] };
  const workspaces={
    currentWorkspace:{ path:workspacePath, projects:[ref] },
    activeProjectRef:ref,
    getProject:(candidate)=>candidate===ref?project:undefined
  };
  const symbols=new CviSymbolService(path.resolve(__dirname,'..'), workspaces);
  const provider=new CviSignatureHelpProvider(symbols);
  const completionProvider=new CviCompletionProvider(symbols);

  await test('package version includes v0.7.40 signature-help fixes',()=>assert(/^0\.7\.(?:4[0-9]|[5-9]\d)$/.test(pkg.version)));
  await test('project signature is available synchronously',()=>{
    const items=symbols.signatureSymbols('hReturn_Meas');
    assert.strictEqual(items.length,1); assert(/short Type/.test(items[0].signature)); assert(/short \*Success/.test(items[0].signature));
  });
  await test('void function exposes zero parameters',()=>assert.deepStrictEqual(extractSignatureParameters('SEQ_API int hReturn_Fail(void)'),[]));
  await test('declspec before function name does not confuse parameter parsing',()=>{
    const p=extractSignatureParameters('__declspec(dllimport) int f(int value, const char *name)', 'f');
    assert.deepStrictEqual(p,['int value','const char *name']);
  });
  await test('normal signature parameters are split',()=>{
    const p=extractSignatureParameters('int f(short Type, double Value, char *Message)');
    assert.deepStrictEqual(p,['short Type','double Value','char *Message']);
  });
  await test('function pointer callback remains one parameter',()=>{
    const p=extractSignatureParameters('void f(void (*callback)(int, void *, void *))');
    assert.deepStrictEqual(p,['void (*callback)(int, void *, void *)']);
  });
  await test('call context begins at parameter zero',()=>assert.deepStrictEqual(findCviCallContext('hReturn_Meas('),{functionName:'hReturn_Meas',activeParameter:0}));
  await test('call context follows commas',()=>assert.deepStrictEqual(findCviCallContext('hReturn_Meas(1, value,'),{functionName:'hReturn_Meas',activeParameter:2}));
  await test('nested call commas do not increment outer argument',()=>assert.deepStrictEqual(findCviCallContext('hReturn_Meas(foo(1, 2), value,'),{functionName:'hReturn_Meas',activeParameter:2}));
  await test('parenthesized expression is skipped while finding outer call',()=>assert.deepStrictEqual(findCviCallContext('hReturn_Meas((a + b), value'),{functionName:'hReturn_Meas',activeParameter:1}));
  await test('strings/comments containing fake calls are ignored',()=>assert.deepStrictEqual(findCviCallContext('printf("hReturn_Meas("); /* x( */ hReturn_Meas('),{functionName:'hReturn_Meas',activeParameter:0}));
  await test('header prototype is preferred over source definition for project signatures',()=>{
    const items=symbols.signatureSymbols('hReturn_Meas'); assert.strictEqual(items.length,1); assert.strictEqual(path.basename(items[0].filePath),'SeqApi.h');
  });
  await test('overloads are preserved for signature help',()=>assert.strictEqual(symbols.signatureSymbols('overload').length,2));
  await test('completion list still deduplicates overload name',()=>assert.strictEqual(symbols.completionSymbols().filter(s=>s.name==='overload').length,1));
  await test('project completion can be disabled independently to avoid duplicate cpptools entries',()=>{
    state.config.enableSupplementalProjectCompletion=false;
    const doc=documentFor('hReturn_', header); const items=completionProvider.provideCompletionItems(doc) || [];
    assert.strictEqual(items.some(x=>x.label==='hReturn_Meas'),false);
    state.config.enableSupplementalProjectCompletion=true;
  });
  await test('completion item commits with opening parenthesis',()=>{
    const doc=documentFor('hReturn_', header); const items=completionProvider.provideCompletionItems(doc); const item=items.find(x=>x.label==='hReturn_Meas');
    assert(item); assert.deepStrictEqual(item.commitCharacters,['(']);
  });
  await test('exact hReturn_Fail(void) case still shows immediate signature with zero parameters',()=>{
    const text='void test(void) {\n  hReturn_Fail('; const doc=documentFor(text, header); const pos=new Position(1,'  hReturn_Fail('.length);
    const help=provider.provideSignatureHelp(doc,pos); assert(help); assert.strictEqual(help.signatures.length,1); assert.strictEqual(help.signatures[0].parameters.length,0); assert(/hReturn_Fail\(void\)/.test(help.signatures[0].label));
  });
  await test('signature provider returns immediate project parameters after opening parenthesis',()=>{
    const text='void test(void) {\n  hReturn_Meas('; const doc=documentFor(text, header); const pos=new Position(1,'  hReturn_Meas('.length);
    const help=provider.provideSignatureHelp(doc,pos); assert(help); assert.strictEqual(help.signatures.length,1); assert.strictEqual(help.signatures[0].parameters.length,8); assert.strictEqual(help.activeParameter,0); assert(/Project symbol/.test(help.signatures[0].documentation.value));
  });
  await test('signature provider tracks active parameter after comma',()=>{
    const text='void test(void) {\n  hReturn_Meas(1, 2.5,'; const doc=documentFor(text, header); const pos=new Position(1,'  hReturn_Meas(1, 2.5,'.length);
    const help=provider.provideSignatureHelp(doc,pos); assert(help); assert.strictEqual(help.activeParameter,2); assert.strictEqual(help.signatures[0].parameters[2].label,'short Digits');
  });
  await test('supplemental signature help can be disabled independently',()=>{
    state.config.enableSupplementalSignatureHelp=false;
    const text='hReturn_Meas('; const doc=documentFor(text,header); const help=provider.provideSignatureHelp(doc,new Position(0,text.length)); assert.strictEqual(help,undefined);
    state.config.enableSupplementalSignatureHelp=true;
  });
  await test('manifest exposes project-completion duplicate control',()=>assert.strictEqual(pkg.contributes.configuration.properties['labwindowsCvi.enableSupplementalProjectCompletion'].default,true));
  await test('manifest exposes signature help setting enabled by default',()=>assert.strictEqual(pkg.contributes.configuration.properties['labwindowsCvi.enableSupplementalSignatureHelp'].default,true));
  await test('extension registers a signature help provider on ( and ,',()=>{
    const source=fs.readFileSync(path.join(__dirname,'..','src','extension.ts'),'utf8');
    assert(source.includes('registerSignatureHelpProvider')); assert(source.includes("'('") && source.includes("','"));
  });

  console.log(`RESULT ${passed} passed, ${failed} failed`);
  if(failed) process.exitCode=1;
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
