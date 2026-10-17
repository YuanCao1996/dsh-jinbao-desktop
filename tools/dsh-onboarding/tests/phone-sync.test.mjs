import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPhoneSync} from '../phone-sync.mjs';
import {createSetupServer} from '../server.mjs';

test('phone publisher ignores IP tokens, whitelists snapshots, sends heartbeats and removes disabled devices',async t=>{
  const stateDir=await mkdtemp(join(tmpdir(),'jinbao-sync-'));let token='jc_'+'1'.repeat(64),time=10000;
  const calls=[];const view={game:'lol',gameTime:'03:00',updatedAt:10000,match:'m1',events:'购买装备：残疫',token:'hidden',source:'private',playerRows:[{champion:'安妮',tierText:'T0',puuid:'private'}]};
  const sync=await createPhoneSync({stateDir,view:()=>view,getToken:async()=>token,serviceBaseUrl:'https://api.jinbaoai.top',now:()=>time,pollMs:100000,fetchImpl:async(url,options)=>{calls.push({url:String(url),...options});return Response.json({accepted:true});}});t.after(sync.close);
  await sync.tick();assert.equal(calls.length,0);
  token='jd_'+'2'.repeat(64);await sync.tick();assert.equal(calls.length,1);assert.equal(calls[0].method,'PUT');
  assert.doesNotMatch(calls[0].body,/hidden|private|puuid|source/);
  await sync.tick();assert.equal(calls.length,1);time+=11000;await sync.tick();assert.equal(calls.length,2);
  await sync.disable();assert.equal(calls.at(-1).method,'DELETE');await sync.tick();assert.equal(calls.length,3);
  assert.equal(JSON.parse(await readFile(join(stateDir,'sync-preferences.json'))).enabled,false);
});

test('linking a WeChat account preserves existing trial billing and BYOK settings',async t=>{
  const values=new Map([['JINBAO_SERVICE_TOKEN','jc_'+'1'.repeat(64)]]),calls=[];
  const credentials={resolve:async key=>values.has(key)?{value:values.get(key)}:undefined,set:async(key,value)=>values.set(key,value),unset:async key=>values.delete(key)};
  const dir=await mkdtemp(join(tmpdir(),'jinbao-sync-link-'));
  const setup=await createSetupServer({credentials,stateDir:dir,port:0,fetchImpl:async(url,options={})=>{
    const path=new URL(url).pathname;calls.push({path,options});
    if(path.endsWith('/start'))return Response.json({deviceSecret:'test-secret',userCode:'1234ABCD',expiresIn:300});
    if(path.endsWith('/poll'))return Response.json({status:'approved',sessionToken:'jd_'+'2'.repeat(64),expiresIn:604800});
    return Response.json({features:{model:true,retrieval:true},approved:true});
  }});t.after(setup.close);
  const [base,nonce]=setup.url.split('/#');
  const post=(path,data)=>fetch(base+'/api/'+path,{method:'POST',headers:{'x-jinbao-setup':nonce,'Content-Type':'application/json'},body:JSON.stringify(data)});
  assert.equal((await post('model',{mode:'byok',baseUrl:'https://vendor.test/v1',model:'own-model',apiKey:'private-key'})).status,200);
  await post('login/start',{});assert.equal((await post('login/poll',{})).status,200);
  assert.equal(values.get('JINBAO_SERVICE_TOKEN'),'jc_'+'1'.repeat(64));assert.equal(values.get('JINBAO_SYNC_TOKEN'),'jd_'+'2'.repeat(64));
  const settings=JSON.parse(await readFile(join(dir,'settings.json'),'utf8'));assert.equal(settings.mode,'byok');assert.equal(settings.model,'own-model');
  assert.ok(!calls.some(c=>c.path==='/desktop/auth/ip/register'));
});
