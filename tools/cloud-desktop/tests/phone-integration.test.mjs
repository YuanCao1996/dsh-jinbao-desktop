import test from'node:test';import assert from'node:assert/strict';import{mkdtemp,mkdir,writeFile,rm}from'node:fs/promises';import{join}from'node:path';import{tmpdir}from'node:os';
import{createSetupServer}from'../../dsh-onboarding/server.mjs';
test('standalone pairing preserves email billing and carries phone chat through the selected Agent',{timeout:15000},async()=>{
 const stateDir=await mkdtemp(join(tmpdir(),'jinbao-phone-integrated-')),cloud='jc_'+'1'.repeat(64),paired='jd_'+'2'.repeat(64),values=new Map([['JINBAO_SERVICE_TOKEN',cloud]]);let setup,questionCount=0,delivered=false,ack=null,snapshot;
 const now=Date.now();await mkdir(join(stateDir,'logs'));await writeFile(join(stateDir,'logs/live.jsonl'),JSON.stringify({game:'lol',match:'one',kind:'game_start',t:now,gameTime:1,me:{champion:'安妮'}})+'\n');
 try{
  setup=await createSetupServer({stateDir,port:0,runtimeId:'standalone',cloudAgent:{ask:async()=>{throw Error('Wrong runtime');}},localAgent:{ask:async request=>{questionCount++;assert.equal(request.game,'lol');return'先买残疫';}},credentials:{resolve:async key=>values.has(key)?{value:values.get(key)}:undefined,set:async(k,v)=>values.set(k,v),unset:async k=>values.delete(k)},fetchImpl:async(url,options={})=>{
   const path=new URL(url).pathname;if(path.endsWith('/device/start'))return Response.json({userCode:'12345678',deviceSecret:'fixture',expiresIn:300});if(path.endsWith('/device/poll'))return Response.json({status:'approved',sessionToken:paired,expiresIn:604800});
   if(path.endsWith('/chat/next')){if(delivered)return Response.json({request:null});delivered=true;return Response.json({request:{id:'11111111-1111-4111-8111-111111111111',lease:'22222222-2222-4222-8222-222222222222',game:'lol',match:'one',question:'怎么出装',leaseUntil:Date.now()+360000}});}
   if(path.includes('/chat/')&&path.endsWith('/result')){ack=JSON.parse(options.body);return Response.json({accepted:true});}if(options.method==='PUT'){assert.equal(options.headers.Authorization,'Bearer '+paired);snapshot=JSON.parse(options.body).snapshot;}return Response.json({enabled:true,loginMethod:'email',features:{model:true,retrieval:true},results:[]});}});
  const url=new URL(setup.url),headers={'X-Jinbao-Setup':url.hash.slice(1),'Content-Type':'application/json'},post=(path,data={})=>fetch(url.origin+'/api/'+path,{method:'POST',headers,body:JSON.stringify(data)});
  assert.equal((await post('model',{mode:'byok',baseUrl:'https://model.example/v1',model:'fixture',apiKey:'fixture'})).status,200);assert.match((await(await post('login/start')).json()).userCode,/^\d{8}$/);await post('login/poll');
  for(let i=0;i<100&&!ack;i++)await new Promise(resolve=>setTimeout(resolve,100));assert.equal(questionCount,1);assert.equal(ack?.answer,'先买残疫');assert.equal(values.get('JINBAO_SERVICE_TOKEN'),cloud);assert.equal(setup.config().mode,'byok');assert.equal(snapshot.game,'lol');
 }finally{await setup?.close();await rm(stateDir,{recursive:true,force:true});}
});
