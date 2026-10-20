import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSetupServer} from '../server.mjs';

test('email login stores credentials privately, binding authenticates existing account and preserves BYOK',async t=>{
 const values=new Map(),calls=[];
 const token='jc_'+'a'.repeat(64),challengeId='b'.repeat(48);
 let rejected=false;
 const setup=await createSetupServer({port:0,stateDir:await mkdtemp(join(tmpdir(),'jinbao-email-')),credentials:{resolve:async k=>values.has(k)?{value:values.get(k)}:null,set:async(k,v)=>values.set(k,v),unset:async k=>values.delete(k)},fetchImpl:async(url,options={})=>{
  const path=new URL(url).pathname;calls.push({path,options});
  if(path.endsWith('/capabilities'))return Response.json({enabled:true});
  if(path.endsWith('/email/send'))return Response.json({challengeId,expiresIn:300,retryAfter:60});
  if(path.endsWith('/email/verify'))return rejected?Response.json({error:'invalid_or_expired_code'},{status:401}):Response.json({sessionToken:token,expiresIn:604800});
  if(path.endsWith('/account'))return Response.json({features:{model:true,retrieval:true},loginMethod:'email'});
  return Response.json({});
 }});t.after(setup.close);
 const [base,nonce]=setup.url.split('/#');
 const request=(path,data)=>fetch(base+'/api/'+path,{method:data===undefined?'GET':'POST',headers:{'X-Jinbao-Setup':nonce,'Content-Type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});
 assert.equal((await(await request('status')).json()).emailEnabled,true);
 assert.equal((await request('login/email/send',{email:'a@example.com',purpose:'login'})).status,200);
 const result=await(await request('login/email/verify',{challengeId,code:'123456'})).json();
 assert.deepEqual(result,{status:'approved'});assert.equal(values.get('JINBAO_SERVICE_TOKEN'),token);
 await request('login/email/send',{email:'a@example.com',purpose:'bind'});
 assert.equal(calls.filter(c=>c.path.endsWith('/email/send')).at(-1).options.headers.Authorization,'Bearer '+token);
 await request('model',{mode:'byok',baseUrl:'https://vendor.test/v1',model:'test',apiKey:'private-key'});
 await request('login/email/verify',{challengeId,code:'123456'});
 assert.equal((await(await request('status')).json()).mode,'byok');
 rejected=true;const failed=await request('login/email/verify',{challengeId,code:'000000'});assert.equal(failed.status,401);assert.match((await failed.json()).error,/验证码/);
 assert.equal(values.get('JINBAO_SERVICE_TOKEN'),token);
});
