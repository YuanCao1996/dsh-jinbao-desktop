import test from'node:test';import assert from'node:assert/strict';import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{createSetupServer}from'../../dsh-onboarding/server.mjs';
test('independent settings and chat work with no local coach connection',async()=>{
 const stateDir=await mkdtemp(join(tmpdir(),'jinbao-independent-')),values=new Map();let localCoachCalls=0,cloudCalls=0;
 const setup=await createSetupServer({stateDir,port:0,cloudAgent:{ask:async request=>{cloudCalls++;assert.equal(request.question,'hi');return'云端回答';}},
 credentials:{resolve:async k=>values.has(k)?{value:values.get(k)}:undefined,set:async(k,v)=>values.set(k,v),unset:async k=>values.delete(k)},
 fetchImpl:async url=>{if(new URL(url).hostname==='127.0.0.1'){localCoachCalls++;throw Error('No local DSH installed');}return Response.json({enabled:true});}});
 try{const u=new URL(setup.url),headers={'X-Jinbao-Setup':u.hash.slice(1),'Content-Type':'application/json'};
 const status=await(await fetch(u.origin+'/api/status',{headers})).json();assert.equal(status.coachReady,true);assert.equal(localCoachCalls,0);
 const reply=await fetch(u.origin+'/api/overlay/ask',{method:'POST',headers,body:JSON.stringify({question:'hi'})});assert.equal(reply.status,200);assert.equal((await reply.json()).answer,'云端回答');assert.equal(cloudCalls,1);assert.equal(localCoachCalls,0);
 for(const path of ['update/check','update/apply'])assert.equal((await fetch(u.origin+'/api/'+path,{method:'POST',headers,body:'{}'})).status,409);
 }finally{await setup.close();await rm(stateDir,{recursive:true,force:true});}
});
test('automatic trial reuses one seat and never overwrites a remembered login or local-mode choice',async()=>{
 const stateDir=await mkdtemp(join(tmpdir(),'jinbao-trial-auto-')),values=new Map();let registrations=0;
 const setup=await createSetupServer({stateDir,port:0,cloudAgent:{ask:async()=>''},localAgent:{ask:async()=>''},credentials:{resolve:async k=>values.has(k)?{value:values.get(k)}:undefined,set:async(k,v)=>values.set(k,v),unset:async k=>values.delete(k)},fetchImpl:async url=>{assert.match(String(url),/ip\/register/);registrations++;return Response.json({sessionToken:'jc_'+'1'.repeat(64)});}});
 try{await Promise.all([setup.ensureTrialLogin(),setup.ensureTrialLogin()]);assert.equal(registrations,1);values.set('JINBAO_SERVICE_TOKEN','jc_'+'2'.repeat(64));await setup.ensureTrialLogin();assert.equal(values.get('JINBAO_SERVICE_TOKEN'),'jc_'+'2'.repeat(64));assert.equal(registrations,1);
 const u=new URL(setup.url);await fetch(u.origin+'/api/model',{method:'POST',headers:{'X-Jinbao-Setup':u.hash.slice(1),'Content-Type':'application/json'},body:JSON.stringify({mode:'byok',baseUrl:'https://vendor.test/v1',model:'test',apiKey:'fixture'})});values.delete('JINBAO_SERVICE_TOKEN');await setup.ensureTrialLogin();assert.equal(registrations,1);assert.equal(setup.config().mode,'byok');
 }finally{await setup.close();await rm(stateDir,{recursive:true,force:true});}
});
