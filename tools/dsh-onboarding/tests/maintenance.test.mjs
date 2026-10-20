import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSetupServer} from '../server.mjs';
test('web maintenance requires local nonce, rejects arbitrary actions, queues repair and exits only owned overlay',async t=>{
 const stateDir=await mkdtemp(join(tmpdir(),'jinbao-maintenance-')),values=new Map();
 const setup=await createSetupServer({stateDir,port:0,credentials:{resolve:async k=>values.has(k)?{value:values.get(k)}:null,set:async(k,v)=>values.set(k,v),unset:async k=>values.delete(k)},fetchImpl:async()=>Response.json({enabled:true})});t.after(setup.close);
 const[base,nonce]=setup.url.split('/#');
 const post=(body,key=nonce)=>fetch(base+'/api/maintenance',{method:'POST',headers:{'X-Jinbao-Setup':key,'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await post({action:'repair'},'invalid')).status,403);
 assert.equal((await post({action:'run',command:'anything'})).status,400);
 assert.equal((await post({action:'repair'})).status,202);
 assert.ok(JSON.parse(await readFile(join(stateDir,'repair-pending.json'))).at);
 assert.equal((await post({action:'exit'})).status,202);
 assert.equal(JSON.parse(await readFile(join(stateDir,'overlay-control.json'))).action,'exit');
 assert.equal(await readFile(join(stateDir,'overlay-stopped'),'utf8'),'closed');
});
