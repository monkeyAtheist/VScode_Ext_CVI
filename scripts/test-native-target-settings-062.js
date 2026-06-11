const fs=require('fs'); const path=require('path'); const os=require('os');
const {CviParser}=require('../out/model/cviParser');
const parser=new CviParser();
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cvi062-'));
const srcRoot='/mnt/data/CVI_PRJ_extract/CVI_PRJ';
function copy(rel){const src=path.join(srcRoot,rel); const dst=path.join(root,path.basename(rel)); fs.copyFileSync(src,dst); return dst;}
function assert(cond,msg){if(!cond)throw new Error(msg)}
const exe=copy('EXE_PRJ/EXE_CONFIGURED_PRJ.prj');
const dll=copy('DLL_PRJ/DLL_CONFIGURED_PRJ.prj');
const lib=copy('LIB_PRJ/LIB_CONFIGURED_PRJ.prj');
let x=parser.getNativeTargetSettings(exe,'debug');
assert(x.targetType==='Executable','exe target'); assert(x.applicationTitle==='ApplicationTitle','exe title'); assert(x.forcedModules.length===4,'exe modules'); assert(x.manifestEmbed,'exe manifest');
parser.setNativeTargetSettings(exe,'debug',{...x, applicationTitle:'UPDATED_TITLE', outputPath:path.join(root,'updated.exe'), forcedModules:['analysis.lib','toolbox.obj']});
x=parser.getNativeTargetSettings(exe,'debug'); assert(x.applicationTitle==='UPDATED_TITLE','exe title write'); assert(x.outputPath.endsWith('updated.exe'),'exe output write'); assert(x.forcedModules.length===2,'exe modules write');
let d=parser.getNativeTargetSettings(dll,'debug');
assert(d.targetType==='Dynamic Link Library','dll target'); assert(d.importLibBaseName==='Import_library_base_name.lib','dll import base'); assert(d.whereToCopyDll==='Custom directory','dll copy'); assert(d.exportFiles.includes('Source File.h'),'dll export'); assert(d.addTypeLibToDll,'dll type lib'); assert(d.forcedModules.length===9,'dll modules');
parser.setNativeTargetSettings(dll,'debug',{...d, importLibBaseName:'changed.lib', exportFiles:['Source File.h'], customDirectoryToCopyDll:root, useDefaultImportLibBaseName:false});
d=parser.getNativeTargetSettings(dll,'debug'); assert(d.importLibBaseName==='changed.lib','dll write'); assert(d.exportFiles[0]==='Source File.h','dll export write');
let l=parser.getNativeTargetSettings(lib,'debug'); assert(l.targetType==='Static Library','lib target'); assert(l.outputPath.toLowerCase().endsWith('.lib'),'lib output');
const backups=[]; for(const f of [exe,dll]){const dir=path.join(path.dirname(f),'.vscode','cvi-native-backups'); if(fs.existsSync(dir)) backups.push(...fs.readdirSync(dir));}
assert(backups.length>=2,'backups');
console.log(JSON.stringify({root, exe:{applicationTitle:x.applicationTitle,output:x.outputPath,modules:x.forcedModules}, dll:{importLibBaseName:d.importLibBaseName,exports:d.exportFiles,modules:d.forcedModules.length}, lib:{output:l.outputPath}, backups:backups.length},null,2));
