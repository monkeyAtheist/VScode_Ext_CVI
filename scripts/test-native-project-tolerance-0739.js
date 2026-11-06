'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CviParser } = require('../out/model/cviParser');
const { IniDocument } = require('../out/model/iniDocument');
const pkg = require('../package.json');

let passed=0, failed=0;
async function test(name, fn){
  try { await fn(); passed++; console.log('PASS '+name); }
  catch(e){ failed++; console.error('FAIL '+name+': '+(e.stack||e)); }
}
function fileIdsFromText(text){ return [...text.matchAll(/^\[File (\d{4})\]\s*$/gm)].map(m=>Number(m[1])); }
function countFileSections(doc){ return doc.sections.filter(s=>/^File \d{4}$/i.test(s.name)).length; }

(async()=>{
  const parser=new CviParser();
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cvi0739-native-'));
  const project=parser.createProject(root,'Legacy','Dynamic Link Library',undefined,2000);
  const sources=[];
  for(let i=1;i<=5;i++){
    const f=path.join(root,`source${i}.c`); fs.writeFileSync(f,`int f${i}(void){return ${i};}\n`); sources.push(f);
  }
  parser.addFilesToProject(project,sources);

  // Simulate a layout seen in real native CVI backups: arbitrary physical order,
  // a stale Number of Files value and Folder declarations interleaved with files.
  let doc=IniDocument.parse(fs.readFileSync(project,'utf8'));
  const header=doc.getSection('Project Header');
  header.set('Number of Files','16');
  const files=doc.sections.filter(s=>/^File \d{4}$/i.test(s.name));
  const nonFiles=doc.sections.filter(s=>!/^File \d{4}$/i.test(s.name));
  const projectHeader=nonFiles.find(s=>s.name.toLowerCase()==='project header');
  const folders=nonFiles.find(s=>s.name.toLowerCase()==='folders');
  const rest=nonFiles.filter(s=>s!==projectHeader && s!==folders);
  // Physical order 4,5,Folders,1,2,3 is legal in CVI.
  doc.sections.splice(0,doc.sections.length,projectHeader,files[3],files[4],folders,files[0],files[1],files[2],...rest);
  // Old projects can omit Folder Id even when Folder is present.
  for(const f of files) f.delete('Folder Id');
  fs.writeFileSync(project,doc.toString());

  await test('package version includes v0.7.39 native-project tolerance fixes',()=>assert(/^0\.7\.(?:39|[4-9]\d)$/.test(pkg.version)));
  await test('stale Number of Files is not a repairable structural error',()=>assert.deepStrictEqual(parser.inspectProjectCompatibility(project),[]));
  await test('arbitrary physical File section order is accepted',()=>assert.deepStrictEqual(fileIdsFromText(fs.readFileSync(project,'utf8')),[4,5,1,2,3]));
  await test('parseProject orders files by native numeric identifier, not physical position',()=>assert.deepStrictEqual(parser.parseProject(project).files.map(f=>f.id),[1,2,3,4,5]));
  await test('missing Folder Id is accepted for legacy/native projects',()=>assert.deepStrictEqual(parser.inspectProjectCompatibility(project),[]));

  const replacement=path.join(root,'replacement.lib'); fs.writeFileSync(replacement,'LIB');
  await test('Replace File succeeds despite stale count/order',()=>parser.replaceFileInProject(project,'File 0005',replacement));
  await test('Replace File does not rewrite stale Number of Files as unrelated side effect',()=>{
    const t=fs.readFileSync(project,'utf8'); assert(/Number of Files\s*=\s*16/.test(t));
  });

  const added=path.join(root,'added.lib'); fs.writeFileSync(added,'LIB2');
  await test('Add Existing File succeeds on unordered project',()=>assert.strictEqual(parser.addFilesToProject(project,[added]),1));
  await test('Add Existing File uses max existing ID + 1',()=>assert(parser.parseProject(project).files.some(f=>f.id===6 && path.basename(f.absolutePath)==='added.lib')));
  await test('Add Existing File appends after the last physical File block without reordering old IDs',()=>{
    const ids=fileIdsFromText(fs.readFileSync(project,'utf8')); assert.deepStrictEqual(ids,[4,5,1,2,3,6]);
  });
  await test('Add Existing File synchronizes Number of Files only because the file set changed',()=>{
    const t=fs.readFileSync(project,'utf8'); assert(/Number of Files\s*=\s*6/.test(t));
  });

  await test('Remove File preserves all surviving native section IDs',()=>{
    parser.removeFileFromProject(project,'File 0002');
    assert.deepStrictEqual(parser.parseProject(project).files.map(f=>f.id),[1,3,4,5,6]);
  });
  await test('Remove File updates count without closing the numeric gap',()=>{
    const t=fs.readFileSync(project,'utf8'); assert(/Number of Files\s*=\s*5/.test(t)); assert(!/^\[File 0002\]/m.test(t)); assert(/^\[File 0006\]/m.test(t));
  });

  // A missing external file is a normal state for USB/network/moved projects and must
  // not trigger Repair on every load.
  fs.unlinkSync(sources[0]);
  await test('missing physical references do not trigger project Repair',()=>assert.deepStrictEqual(parser.inspectProjectCompatibility(project),[]));
  await test('conservative Repair leaves tolerated native layout byte-identical',()=>{
    const before=fs.readFileSync(project);
    const result=parser.repairProjectCompatibility(project);
    const after=fs.readFileSync(project);
    assert.strictEqual(result.changed,false); assert(before.equals(after));
  });

  // Gap fixture modeled after real CVI backups (e.g. missing File 0012 while later IDs exist).
  const gapProject=path.join(root,'Gap.prj'); fs.copyFileSync(project,gapProject);
  let gapDoc=IniDocument.parse(fs.readFileSync(gapProject,'utf8'));
  const sec3=gapDoc.getSection('File 0003');
  if(sec3) gapDoc.removeSection('File 0003');
  gapDoc.getSection('Project Header').set('Number of Files',String(countFileSections(gapDoc)));
  fs.writeFileSync(gapProject,gapDoc.toString());
  const gapAdd=path.join(root,'gap-add.lib'); fs.writeFileSync(gapAdd,'G');
  await test('numeric gaps are accepted and Add does not renumber surviving files',()=>{
    parser.addFilesToProject(gapProject,[gapAdd]);
    const ids=parser.parseProject(gapProject).files.map(f=>f.id);
    assert(!ids.includes(3)); assert(ids.includes(7));
  });

  // Duplicate exact section names remain ambiguous and are the kind of condition the
  // write barrier is still allowed to reject.
  const dupProject=path.join(root,'Duplicate.prj'); fs.copyFileSync(project,dupProject);
  let dupDoc=IniDocument.parse(fs.readFileSync(dupProject,'utf8'));
  const first=dupDoc.getSection('File 0001');
  dupDoc.sections.push(Object.assign(Object.create(Object.getPrototypeOf(first)), {name:first.name, lines:[...first.lines]}));
  fs.writeFileSync(dupProject,dupDoc.toString());
  const repl2=path.join(root,'dup-repl.lib'); fs.writeFileSync(repl2,'D');
  await test('duplicate exact File section remains protected as ambiguous',()=>{
    assert.throws(()=>parser.replaceFileInProject(dupProject,'File 0001',repl2),/duplicate section \[File 0001\]/i);
  });

  await test('CVI 2012-style project keeps Folder-without-Folder-Id when adding files',()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cvi0739-v1200-'));
    const prj=parser.createProject(dir,'Old','Dynamic Link Library',undefined,1200);
    const a=path.join(dir,'a.c'); fs.writeFileSync(a,'int a;'); parser.addFilesToProject(prj,[a]);
    const b=path.join(dir,'b.lib'); fs.writeFileSync(b,'b'); parser.addFilesToProject(prj,[b]);
    const t=fs.readFileSync(prj,'utf8');
    const sec=t.match(/\[File 0002\]([\s\S]*?)(?=\r?\n\[|$)/);
    assert(sec && /Folder\s*=/.test(sec[1])); assert(!/^Folder Id\s*=/m.test(sec[1]));
  });
  await test('modern project keeps Folder Id style when native project uses it',()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cvi0739-v2000-'));
    const prj=parser.createProject(dir,'New','Dynamic Link Library',undefined,2000);
    const a=path.join(dir,'a.c'); fs.writeFileSync(a,'int a;'); parser.addFilesToProject(prj,[a]);
    const b=path.join(dir,'b.lib'); fs.writeFileSync(b,'b'); parser.addFilesToProject(prj,[b]);
    const t=fs.readFileSync(prj,'utf8');
    const sec=t.match(/\[File 0002\]([\s\S]*?)(?=\r?\n\[|$)/);
    assert(sec && /^Folder Id\s*=\s*\d+/m.test(sec[1]));
  });

  console.log(`RESULT ${passed} passed, ${failed} failed`);
  if(failed) process.exitCode=1;
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
