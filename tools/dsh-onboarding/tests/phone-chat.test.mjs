import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPhoneChat} from '../phone-chat.mjs';
const id='11111111-1111-4111-8111-111111111111',lease='22222222-2222-4222-8222-222222222222';
const request=()=>({id,lease,game:'lol',match:'m1',question:'如何出装',leaseUntil:Date.now()+360000});

test('phone command uses existing chat once and retries acknowledgement without another inference',async t=>{
  const stateDir=await mkdtemp(join(tmpdir(),'jinbao-phone-chat-'));let asks=0,claims=0,acks=0;
  const worker=await createPhoneChat({stateDir,deviceId:id,getToken:async()=> 'jd_'+'a'.repeat(64),view:()=>({game:'lol',match:'m1'}),ask:async(q,_topic,meta)=>{asks++;assert.equal(meta.origin,'phone');return {answer:'稳健出装'};},serviceBaseUrl:'https://api.jinbaoai.top',pollMs:100000,
    fetchImpl:async(url,options)=>{if(String(url).endsWith('/next')){claims++;return Response.json({request:request()});}acks++;assert.equal(JSON.parse(options.body).answer,'稳健出装');return Response.json({accepted:true});}});t.after(worker.close);
  await worker.tick();assert.equal(asks,1);assert.equal(claims,1);assert.equal(acks,1);
});

test('stale match fails without invoking Agent; IP trial cannot claim remote commands',async t=>{
  let token='jc_'+'a'.repeat(64),calls=0,failed;
  const worker=await createPhoneChat({stateDir:await mkdtemp(join(tmpdir(),'jinbao-phone-stale-')),deviceId:id,getToken:async()=>token,view:()=>({game:'lol',match:'m2'}),ask:async()=>{throw Error('must not infer');},serviceBaseUrl:'https://api.jinbaoai.top',pollMs:100000,
    fetchImpl:async(url,options)=>{calls++;if(String(url).endsWith('/next'))return Response.json({request:request()});failed=JSON.parse(options.body);return Response.json({accepted:true});}});t.after(worker.close);
  await worker.tick();assert.equal(calls,0);token='jd_'+'a'.repeat(64);await worker.tick();assert.equal(failed.error,'match_changed');
});

test('unacknowledged successful result survives restart without repeating the model call',async()=>{
  const stateDir=await mkdtemp(join(tmpdir(),'jinbao-phone-ack-'));let asks=0;
  const options={stateDir,deviceId:id,getToken:async()=> 'jd_'+'a'.repeat(64),view:()=>({game:'lol',match:'m1'}),ask:async()=>{asks++;return {answer:'已回复'};},serviceBaseUrl:'https://api.jinbaoai.top',pollMs:100000};
  const first=await createPhoneChat({...options,fetchImpl:async(url)=>String(url).endsWith('/next')?Response.json({request:request()}):new Response('',{status:503})});
  await first.tick();await first.close();assert.equal(JSON.parse(await readFile(join(stateDir,'phone-chat-receipt.json'),'utf8')).status,'complete');
  let ack;const second=await createPhoneChat({...options,fetchImpl:async(_url,options)=>{ack=JSON.parse(options.body);return Response.json({accepted:true});}});
  await second.tick();await second.close();assert.equal(asks,1);assert.equal(ack.answer,'已回复');
});
