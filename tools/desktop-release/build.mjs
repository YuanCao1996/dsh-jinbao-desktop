import { readFileSync,writeFileSync,readdirSync,mkdirSync,cpSync,copyFileSync,existsSync,statSync } from 'node:fs';
import { join,resolve,dirname,relative } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
if(process.platform!=='win32')throw Error('Windows release builds must run on Windows');
const root=resolve('.'),out=resolve(process.argv[2]??'workspace/client-releases/jinbao-desktop');
if(existsSync(out))throw Error('Choose a new output directory; existing releases are never overwritten');
mkdirSync(join(out,'tools'),{recursive:true});
for(const name of ['dsh-onboarding','dsh-game-services','dsh-coach-server','desktop-release']){
 cpSync(join(root,'tools',name),join(out,'tools',name),{recursive:true,filter:p=>!p.includes('tests')&&!p.includes('.bak')&&!p.endsWith('build.mjs')});
}
mkdirSync(join(out,'tools','lol-companion'),{recursive:true});
for(const name of ['collector.mjs','lockfile.mjs','lcu.mjs','live.mjs','eventlog.mjs'])copyFileSync(join(root,'tools/lol-companion',name),join(out,'tools/lol-companion',name));
const req=createRequire(join(root,'package.json')),packages=new Set();
function walk(dir,includeModules=false){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?(e.name==='node_modules'&&!includeModules?[]:walk(join(dir,e.name),includeModules)):[join(dir,e.name)]);}
function bundle(name){
 if(packages.has(name)||name.startsWith('node:'))return;
 let manifest;try{manifest=req.resolve(name+'/package.json');}catch{let f=req.resolve(name);while(!existsSync(join(dirname(f),'package.json')))f=dirname(f);manifest=join(dirname(f),'package.json');}
 const dir=dirname(manifest),pkg=JSON.parse(readFileSync(manifest));packages.add(name);
 const dest=join(out,'node_modules',name);cpSync(dir,dest,{recursive:true,filter:p=>!relative(dir,p).split(requireSeparator()).some(part=>part==='node_modules'||part==='test'||part==='tests')&&!p.endsWith('.map')&&!p.endsWith('.ts')});
 for(const file of walk(dir).filter(f=>f.endsWith('.js')||f.endsWith('.mjs')||f.endsWith('.cjs'))){
  const text=readFileSync(file,'utf8');
  for(const m of text.matchAll(/(?:from\s*|import\s*\(|require\s*\(|import\s*)['"]([^'"]+)['"]/g)){
   const spec=m[1];if(spec.startsWith('.')||spec.startsWith('/')||spec.startsWith('node:')||!spec.includes('/')){if(!spec.startsWith('.')&&['yaml','chokidar','cosmokit','cordis','schemastery'].includes(spec))bundle(spec);continue;}
   bundle(spec.startsWith('@')?spec.split('/').slice(0,2).join('/'):spec.split('/')[0]);
  }
 }
}
function requireSeparator(){return process.platform==='win32'?'\\':'/';}
for(const name of ['@deepseek-ai/schemastery','@deepseek-ai/dsh-tools','@deepseek-ai/dsh-session','yaml'])bundle(name);
mkdirSync(join(out,'runtime'),{recursive:true});copyFileSync(process.execPath,join(out,'runtime','node.exe'));
const license=join(dirname(process.execPath),'LICENSE');
const nodeLicense=existsSync(license)?license:join(root,'third-party/node-LICENSE.txt');
copyFileSync(nodeLicense,join(out,'runtime','LICENSE'));
writeFileSync(join(out,'install.cmd'),'@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\\desktop-release\\install.ps1" -NodePath "%~dp0runtime\\node.exe"\r\npause\r\n');
writeFileSync(join(out,'settings.cmd'),'@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\\desktop-release\\open-settings.ps1"\r\npause\r\n');
mkdirSync(join(out,'runtime/platform-tools'),{recursive:true});
if(!process.env.JINBAO_BUILD_ADB_DIR)throw Error('Set JINBAO_BUILD_ADB_DIR to your Android platform-tools directory');
const adbSource=resolve(process.env.JINBAO_BUILD_ADB_DIR);
for(const name of ['adb.exe','AdbWinApi.dll','AdbWinUsbApi.dll','NOTICE.txt'])copyFileSync(join(adbSource,name),join(out,'runtime/platform-tools',name));
writeFileSync(join(out,'overlay.cmd'),'@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\\desktop-release\\start-overlay.ps1"\r\n');
writeFileSync(join(out,'lol.cmd'),'@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\\desktop-release\\start-overlay.ps1"\r\n"%~dp0runtime\\node.exe" "%~dp0tools\\lol-companion\\collector.mjs"\r\npause\r\n');
writeFileSync(join(out,'wzry.cmd'),'@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\\desktop-release\\start-overlay.ps1"\r\n"%~dp0runtime\\node.exe" "%~dp0tools\\desktop-release\\capture-wzry.mjs"\r\npause\r\n');
cpSync(join(root,'docs'),join(out,'docs'),{recursive:true});
copyFileSync(join(root,'LICENSE'),join(out,'LICENSE'));
copyFileSync(join(root,'tools/desktop-release/menu.cmd'),join(out,'开始使用.cmd'));
copyFileSync(join(root,'README.md'),join(out,'README.md'));
const files=walk(out,true).map(f=>({path:f.slice(out.length+1).replaceAll('\\','/'),bytes:statSync(f).size,sha256:createHash('sha256').update(readFileSync(f)).digest('hex')}));
writeFileSync(join(out,'manifest.json'),JSON.stringify({version:JSON.parse(readFileSync(join(root,'package.json'))).version,node:process.version,packages:[...packages],files},null,2));
console.log(JSON.stringify({out,files:files.length,packages:packages.size,bytes:files.reduce((n,f)=>n+f.bytes,0)}));
