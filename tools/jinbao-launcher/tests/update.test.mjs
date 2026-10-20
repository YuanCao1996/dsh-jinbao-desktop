import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, access, readdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createUpdater, compareVersions, verifyRelease, extractArchive } from '../update.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const required=['runtime/node.exe','start-jinbao.vbs','tools/jinbao-launcher/start.ps1','tools/jinbao-launcher/main.mjs','tools/jinbao-launcher/update.mjs'];
function zip(files) {
  const records=[],directory=[];let offset=0;
  for(const [name,bytes] of Object.entries(files)) {
    const path=Buffer.from(name);const data=Buffer.from(bytes);let crc=0xffffffff;
    for(const byte of data){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
    crc=(crc^0xffffffff)>>>0;
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(path.length,26);
    records.push(local,path,data);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(path.length,28);central.writeUInt32LE(offset,42);
    directory.push(central,path);offset+=local.length+path.length+data.length;
  }
  const table=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(table.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...records,table,end]);
}
async function fixture(version='2.0.0') {
  const directory=await mkdtemp(join(tmpdir(),'jinbao-update 中文-'));
  const root=join(directory,'original'),stateDir=join(directory,'user');
  await mkdir(root);await mkdir(stateDir);
  await writeFile(join(root,'manifest.json'),JSON.stringify({version:'1.0.0',files:[]}));
  await writeFile(join(stateDir,'settings.json'),'private settings stay untouched');
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  const files=Object.fromEntries(required.map(name=>[name,'test package '+name]));
  files['manifest.json']=JSON.stringify({version,files:Object.entries(files).map(([path,data])=>({path,bytes:Buffer.byteLength(data),sha256:hash(data)}))});
  const archive=zip(files);
  const release={version,url:`https://api.jinbaoai.top/downloads/dsh/v${version}/jinbao-desktop-windows.zip`,bytes:archive.length,sha256:hash(archive),manifestSha256:hash(files['manifest.json'])};
  const envelopeFor=r=>{const payload=Buffer.from(JSON.stringify(r));return {payload:payload.toString('base64'),signature:sign(null,payload,privateKey).toString('base64')};};
  let envelope=envelopeFor(release),download=archive,extractions=0,requests=0;
  const options={root,stateDir,publicKey,fetchImpl:async url=>{requests++;return url.endsWith('latest.json')?Response.json(envelope):new Response(download);},extract:async(_archive,dest)=>{
    extractions++;for(const [name,data]of Object.entries(files)){const path=join(dest,name);await mkdir(dirname(path),{recursive:true});await writeFile(path,data);}
  }};
  return {directory,root,stateDir,release,files,archive,options,envelopeFor,publicKey,
    setEnvelope:v=>{envelope=v;},setDownload:v=>{download=v;},extractions:()=>extractions,requests:()=>requests};
}

test('signed updates download once, activate on the next launch, preserve user data and reject rollback',async()=>{
  const f=await fixture();const updater=createUpdater(f.options);await updater.check();
  const next=await updater.resolve();assert.notEqual(next,f.root);
  assert.equal(JSON.parse(await readFile(join(f.stateDir,'updates/status.json'))).state,'ready');
  await updater.check();assert.equal(f.extractions(),1);
  assert.equal(await readFile(join(f.stateDir,'settings.json'),'utf8'),'private settings stay untouched');
  await createUpdater({...f.options,root:next}).healthy();
  const result=JSON.parse(await readFile(join(f.stateDir,'updates/result.json')));assert.equal(result.state,'success');assert.equal(result.version,'2.0.0');
  await createUpdater({...f.options,root:next}).check();
  assert.equal(JSON.parse(await readFile(join(f.stateDir,'updates/result.json'))).id,result.id);
  assert.equal(await updater.resolve(),next);
  f.setEnvelope(f.envelopeFor({...f.release,version:'1.5.0',url:'https://api.jinbaoai.top/downloads/dsh/v1.5.0/jinbao-desktop-windows.zip'}));
  await updater.check();assert.equal(f.extractions(),1);assert.equal(await updater.resolve(),next);
  await createUpdater({...f.options,root:next}).reject();assert.equal(await updater.resolve(),f.root);
  assert.equal(JSON.parse(await readFile(join(f.stateDir,'updates/result.json'))).state,'rollback');
  await updater.check();assert.equal(f.extractions(),1);
});

test('download progress is bounded and cached ready update survives an offline check',async()=>{
 const f=await fixture();const stages=[];
 const originalFetch=f.options.fetchImpl,progress=[];let tick=0;f.options.now=()=>tick+=600;
 f.options.fetchImpl=async url=>url.endsWith('latest.json')?originalFetch(url):{ok:true,body:{async *[Symbol.asyncIterator](){for(const chunk of [f.archive.subarray(0,Math.floor(f.archive.length/2)),f.archive.subarray(Math.floor(f.archive.length/2))]){yield chunk;const status=JSON.parse(await readFile(join(f.stateDir,'updates/status.json')));progress.push(status.percent);}}}};
 f.options.extract=async(_archive,dest)=>{
  stages.push(JSON.parse(await readFile(join(f.stateDir,'updates/status.json'))).state);
  for(const [name,data]of Object.entries(f.files)){const path=join(dest,name);await mkdir(dirname(path),{recursive:true});await writeFile(path,data);}
 };
 const updater=createUpdater(f.options);await updater.check();assert.deepEqual(stages,['extracting']);assert.ok(await updater.prepared());assert.equal(progress.length,2);assert.ok(progress[0]>0&&progress[0]<100);assert.equal(progress[1],100);
 f.options.fetchImpl=async()=>{throw Error('offline');};await createUpdater(f.options).check();assert.equal(JSON.parse(await readFile(join(f.stateDir,'updates/status.json'))).state,'ready');
});

test('bad signatures, altered downloads and incomplete packages never replace the working entry',async()=>{
  for(const fault of ['signature','checksum','missing','offline']) {
    const f=await fixture();
    if(fault==='signature')f.setEnvelope({payload:f.envelopeFor(f.release).payload,signature:Buffer.alloc(64).toString('base64')});
    if(fault==='checksum')f.setDownload(Buffer.alloc(f.archive.length));
    if(fault==='missing')delete f.files['tools/jinbao-launcher/start.ps1'];
    if(fault==='offline')f.options.fetchImpl=async()=>{throw Error('offline');};
    const updater=createUpdater(f.options);await updater.check();assert.equal(await updater.resolve(),f.root);
    assert.equal(await readFile(join(f.stateDir,'settings.json'),'utf8'),'private settings stay untouched');
    assert.equal((await readdir(join(f.stateDir,'updates'))).some(name=>name.startsWith('staging-')||name.endsWith('.zip')),false);
  }
});

test('damaged cached updates fall back; semver and signed URL checks prevent arbitrary execution',async()=>{
  const f=await fixture();const updater=createUpdater(f.options);await updater.check();
  const next=await updater.resolve();await writeFile(join(next,'tools/jinbao-launcher/main.mjs'),'changed');
  assert.equal(await updater.resolve(),f.root);
  assert.equal(compareVersions('1.10.0','1.9.9'),1);assert.equal(compareVersions('1.0.0','1.0.0'),0);
  assert.throws(()=>compareVersions('../1','1.0.0'));
  assert.throws(()=>verifyRelease(f.envelopeFor({...f.release,url:'https://evil.example/update.zip'}),f.publicKey));
});

test('native ZIP extraction rejects traversal and accepts the signed release layout', {skip:process.platform!=='win32'},async()=>{
  const f=await fixture();const good=join(f.directory,'good.zip');await writeFile(good,f.archive);
  const dest=join(f.directory,'good');await extractArchive(good,dest);await access(join(dest,'manifest.json'));
  for(const name of ['../escaped.txt','/absolute.txt','C:/absolute.txt','foo/../escaped.txt','folder\\escape.txt']){
    const path=join(f.directory,'unsafe.zip');await writeFile(path,zip({'manifest.json':'{}',[name]:'bad'}));
    await assert.rejects(extractArchive(path,join(f.directory,'unsafe')));
  }
  await assert.rejects(access(join(f.directory,'escaped.txt')));
});

test('native portable entry routes to a verified new version and falls back when its startup fails', {skip:process.platform!=='win32'},async()=>{
  const f=await fixture();const candidate=join(f.stateDir,'updates/releases/v2.0.0');
  const source=new URL('../',import.meta.url);
  const launchers=[f.root,candidate];
  const main="import{writeFile,readFile}from'node:fs/promises';import{join}from'node:path';const args=process.argv.slice(2);const s=args[args.indexOf('--state')+1];const v=JSON.parse(await readFile(new URL('../../manifest.json',import.meta.url))).version;await writeFile(join(s,'ran-version.txt'),v);";
  for(const root of launchers){
    await mkdir(join(root,'runtime'),{recursive:true});await copyFile(process.execPath,join(root,'runtime/node.exe'));
    await mkdir(join(root,'tools/jinbao-launcher'),{recursive:true});await mkdir(join(root,'tools/desktop-release'),{recursive:true});
    for(const name of ['start.ps1','update.mjs'])await copyFile(new URL(name,source),join(root,'tools/jinbao-launcher',name));
    await writeFile(join(root,'tools/jinbao-launcher/update-public.pem'),f.publicKey.export({type:'spki',format:'pem'}));
    await writeFile(join(root,'tools/jinbao-launcher/legacy-overlay.ps1'),'function Find-JinbaoLegacyOverlay { return @() }');
    await writeFile(join(root,'tools/desktop-release/start-overlay.ps1'),'param([string]$StateDir)');
    await writeFile(join(root,'tools/jinbao-launcher/main.mjs'),main);
    await writeFile(join(root,'start-jinbao.vbs'),'test fixture');
  }
  async function seal(){
    const paths=[...required,'tools/jinbao-launcher/update-public.pem','tools/jinbao-launcher/legacy-overlay.ps1','tools/desktop-release/start-overlay.ps1'];
    const files=await Promise.all(paths.map(async path=>{const data=await readFile(join(candidate,path));return{path,bytes:data.length,sha256:hash(data)};}));
    const manifest=JSON.stringify({version:'2.0.0',files});await writeFile(join(candidate,'manifest.json'),manifest);
    await writeFile(join(f.stateDir,'updates/pending.json'),JSON.stringify(f.envelopeFor({...f.release,manifestSha256:hash(manifest)})));
  }
  await seal();const exec=promisify(execFile);const ps=join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
  const args=['-NoProfile','-ExecutionPolicy','Bypass','-File',join(f.root,'tools/jinbao-launcher/start.ps1'),'-StateDir',f.stateDir];
  await exec(ps,args,{windowsHide:true,timeout:30000});assert.equal(await readFile(join(f.stateDir,'ran-version.txt'),'utf8'),'2.0.0');
  await writeFile(join(candidate,'tools/jinbao-launcher/main.mjs'),'process.exit(8);');await seal();
  await exec(ps,args,{windowsHide:true,timeout:30000});assert.equal(await readFile(join(f.stateDir,'ran-version.txt'),'utf8'),'1.0.0');
  assert.equal(JSON.parse(await readFile(join(f.stateDir,'updates/rejected.json'))).version,'2.0.0');
});
