import test from 'node:test';import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,createHash}from'node:crypto';import {mkdtemp,mkdir,writeFile,readFile,cp,rm}from'node:fs/promises';import{join}from'node:path';import{tmpdir}from'node:os';
import{createUpdater,verifyRelease}from'../../jinbao-launcher/update.mjs';import{createStandaloneUpdates}from'../updates.mjs';
import{runEntry}from'../entry.mjs';import{EventEmitter}from'node:events';
const digest=b=>createHash('sha256').update(b).digest('hex');
test('standalone signed channel rejects legacy packages, stages the right runtime and retains settings',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jinbao-independent-update-'));const{privateKey,publicKey}=generateKeyPairSync('ed25519');
 try{
  const root=join(dir,'old'),next=join(dir,'new'),stateDir=join(dir,'state');await mkdir(root);await mkdir(next);await mkdir(stateDir);
  await writeFile(join(root,'manifest.json'),JSON.stringify({version:'0.2.0',runtime:'standalone',files:[]}));await writeFile(join(stateDir,'settings.json'),'{"mode":"byok"}');
  const files=[];for(const path of ['runtime/node.exe','start-preview.vbs','tools/cloud-desktop/entry.mjs','tools/cloud-desktop/main.mjs','tools/jinbao-launcher/update.mjs']){const bytes=Buffer.from('fixture '+path);await mkdir(join(next,path,'..'),{recursive:true});await writeFile(join(next,path),bytes);files.push({path,bytes:bytes.length,sha256:digest(bytes)});}
  const manifest=Buffer.from(JSON.stringify({version:'0.2.1',runtime:'standalone',files}));await writeFile(join(next,'manifest.json'),manifest);const archive=Buffer.from('signed fixture');
  const release={runtime:'standalone',version:'0.2.1',url:'https://api.jinbaoai.top/downloads/jinbao/v0.2.1/jinbao-desktop-windows.zip',bytes:archive.length,sha256:digest(archive),manifestSha256:digest(manifest),notes:'独立版更新'};
  const payload=Buffer.from(JSON.stringify(release)),envelope={payload:payload.toString('base64'),signature:sign(null,payload,privateKey).toString('base64')};assert.throws(()=>verifyRelease(envelope,publicKey));assert.equal(verifyRelease(envelope,publicKey,'standalone').runtime,'standalone');
  const urls=[];const updater=createUpdater({root,stateDir,channel:'standalone',publicKey,extract:(_archive,destination)=>cp(next,destination,{recursive:true}),fetchImpl:async url=>{urls.push(String(url));return String(url).endsWith('latest.json')?Response.json(envelope):new Response(archive);}});
  await updater.check();assert.match(urls[0],/downloads\/jinbao\//);const prepared=await updater.prepared();assert.equal(prepared.release.version,'0.2.1');assert.equal(await updater.resolve(),prepared.root);assert.equal(JSON.parse(await readFile(join(stateDir,'settings.json'),'utf8')).mode,'byok');
  const controller=createStandaloneUpdates({root,stateDir,updater,restart:async()=>{urls.push('restarted');},now:()=>1000});await assert.rejects(controller.apply({match:'one',ended:false,gameTime:'01:00',updatedAt:1000}),e=>e.status===409);assert.ok(!urls.includes('restarted'));await controller.apply({ended:true});assert.ok(urls.includes('restarted'));await controller.close();
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('standalone entry falls back after an executable startup error before ready',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jinbao-entry-fallback-')),root=join(dir,'old'),candidate=join(dir,'new'),stateDir=join(dir,'state'),starts=[];
 try{await mkdir(root);await mkdir(candidate);await mkdir(stateDir);await writeFile(join(candidate,'manifest.json'),JSON.stringify({version:'0.2.1'}));
 const code=await runEntry({root,stateDir,updater:{resolve:async()=>candidate},startupTimeoutMs:1000,spawnImpl:executable=>{const child=new EventEmitter();child.kill=()=>{};starts.push(executable);setImmediate(()=>{if(starts.length===1)child.emit('error',Error('fixture executable unavailable'));else{child.emit('message',{action:'ready'});child.emit('exit',0);}});return child;}});assert.equal(code,0);assert.equal(starts.length,2);assert.ok(starts[1].startsWith(root));assert.equal(JSON.parse(await readFile(join(stateDir,'updates/result.json'))).state,'rollback');
 }finally{await rm(dir,{recursive:true,force:true});}
});
