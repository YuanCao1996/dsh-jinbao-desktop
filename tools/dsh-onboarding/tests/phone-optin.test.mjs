import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createSetupServer} from '../server.mjs';
test('USB capture is explicit opt-in, authenticated, persistent and independently switchable from cloud/model settings',async t=>{
 const stateDir=await mkdtemp(join(tmpdir(),'jinbao-phone-optin-'));const credentials={resolve:async()=>null,set:async()=>{}};
 const server=await createSetupServer({stateDir,port:0,credentials,fetchImpl:async()=>Response.json({})});t.after(server.close);
 const [base,nonce]=server.url.split('/#');const call=(path,data,authorized=true)=>fetch(base+'/api/'+path,{method:data===undefined?'GET':'POST',headers:{...(authorized?{'X-Jinbao-Setup':nonce}:{}),'Content-Type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});
 assert.equal((await(await call('status')).json()).phoneCaptureEnabled,false);
 assert.equal((await call('phone/capture',{enabled:true},false)).status,403);
 assert.equal((await call('phone/capture',{enabled:'true'})).status,400);
 assert.equal((await call('phone/capture',{enabled:true})).status,200);
 assert.equal(JSON.parse(await readFile(join(stateDir,'phone-capture.json'))).enabled,true);
 assert.equal((await(await call('status')).json()).phoneCaptureEnabled,true);
 await call('phone/capture',{enabled:false});assert.equal((await(await call('status')).json()).phoneCaptureEnabled,false);
});
