import test from 'node:test';import assert from 'node:assert/strict';
import {createGenericIdentity,parseGenericObservation} from '../generic-identity.mjs';
import {createDesktopObservation} from '../observation.mjs';
import {createCloudAgent,cloudContext} from '../cloud-agent.mjs';
import {createWebSearch} from '../web-search.mjs';
import {mkdtemp,rm} from 'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
import {createSetupServer} from '../../dsh-onboarding/server.mjs';
import {createOverlayService} from '../../dsh-onboarding/overlay-state.mjs';
const field=value=>({value,confidence:'high',evidence:['画面中的明确文字']});
test('identity needs distinct evidence, survives the low-frequency interval and never promotes low confidence',()=>{
 let time=0;const ledger=createGenericIdentity({now:()=>time});
 ledger.observe({game_name:field('游戏甲')},'frame1');ledger.observe({game_name:field('游戏甲')},'frame1');assert.equal(ledger.snapshot().confirmed.game_name,undefined);
 time+=70000;ledger.observe({game_name:field('游戏甲')},'frame2');assert.equal(ledger.snapshot().confirmed.game_name.value,'游戏甲');
 ledger.observe({game_mode:{...field('模式甲'),confidence:'low'}},'frame3');ledger.observe({game_mode:{...field('模式甲'),confidence:'low'}},'frame4');assert.equal(ledger.snapshot().confirmed.game_mode,undefined);
 assert.equal(parseGenericObservation('不是JSON'),null);assert.deepEqual(parseGenericObservation('{"observations":"已读","identity":{"game_phase":{"value":"evil","confidence":"high","evidence":["x"]}}}').identity,{});
});
test('a suspected game switch does not mix modes or silently replace a user confirmation',()=>{
 const ledger=createGenericIdentity();ledger.confirm({game_name:'游戏甲',game_mode:'模式甲'});
 for(const id of ['1','2'])ledger.observe({game_name:field('游戏乙'),game_mode:field('模式乙')},id);
 assert.equal(ledger.snapshot().confirmed.game_name.value,'游戏甲');assert.equal(ledger.snapshot().confirmed.game_mode.value,'模式甲');assert.equal(ledger.snapshot().tentative.game_name.value,'游戏乙');
 ledger.confirm({game_name:'游戏乙'});assert.equal(ledger.snapshot().confirmed.game_mode,undefined);
});
function fixture(){
 let time=10000;const events=[];
 const observer={list:async()=>[{id:'window',title:'授权游戏窗口',foreground:true}],select:async()=>({id:'window',title:'授权游戏窗口'}),clear(){},capture:async()=>({frame:{captured_at_ms:time},png:Buffer.from('frame-'+time),image:{width:8,height:8,rgb:Buffer.alloc(192,120)}})};
 const c=createDesktopObservation({stateDir:'.',view:()=>({}),observer,now:()=>time,publish:async event=>events.push(event)});
 return{c,events,observer,advance(ms){time+=ms;},async frame(){this.advance(70000);return c.capture({game:'generic',match:c.status().match});},async read(phase){const frame=await this.frame();const input={game:'generic',match:c.status().match,captured_at_ms:frame.captured_at_ms,source_sha256:frame.source_sha256,identity:{game_name:field('游戏甲'),game_phase:field(phase)}};return {frame,input,result:await c.feedback(input)};}};
}
test('window feedback starts rounds, isolates results, and requires fresh observations for the next round',async()=>{
 const f=fixture();await f.c.start({targetId:'window',authorized:true});const watching=f.c.status().match;
 await f.read('playing');await f.read('playing');const started=await f.read('playing');assert.equal(started.result.rotated,true);assert.notEqual(f.c.status().match,watching);assert.equal(f.c.status().roundState,'playing');const first=f.c.status().match;
 await f.read('results');assert.equal(f.c.status().match,first);await f.read('results');assert.equal(f.c.status().roundState,'between');const between=f.c.status().match;
 await f.read('playing');assert.equal(f.c.status().match,between);await f.read('playing');assert.equal(f.c.status().roundState,'playing');assert.notEqual(f.c.status().match,between);
 assert.equal((await f.c.feedback(started.input)).reason,'session_changed');assert.ok(f.events.some(e=>e.reason==='round_end'));await f.c.close();
});
test('unissued, duplicate and stale frames never corroborate identity or split a round',async()=>{
 const f=fixture();await f.c.start({targetId:'window',authorized:true});const {input}=await f.read('menu');
 assert.equal((await f.c.feedback(input)).reason,'duplicate_frame');assert.equal((await f.c.feedback({...input,source_sha256:'fake'})).accepted,false);
 const frame=await f.frame();f.advance(30001);assert.equal((await f.c.feedback({...input,captured_at_ms:frame.captured_at_ms,source_sha256:frame.source_sha256})).accepted,false);
 assert.equal(f.c.status().identity.confirmed.game_name,undefined);await f.c.close();
});
test('manual identity and new round preserve the selected window but discard previous frame receipts',async()=>{
 const f=fixture();await f.c.start({targetId:'window',authorized:true});await f.c.confirm({game_name:'用户游戏',game_mode:'用户模式'});
 const before=f.c.status().match,frame=await f.frame();await f.c.newRound();assert.notEqual(f.c.status().match,before);assert.equal(f.c.status().targetId,'window');assert.equal(f.c.status().identity.confirmed.game_name.status,'user_confirmed');
 assert.equal(f.c.status().identity.confirmed.game_mode,undefined);
 assert.equal((await f.c.feedback({game:'generic',match:before,captured_at_ms:frame.captured_at_ms,source_sha256:frame.source_sha256,identity:{}})).accepted,false);await f.c.close();
});

test('out-of-order analyzed frames cannot roll back current identity',async()=>{
 const f=fixture();await f.c.start({targetId:'window',authorized:true});const old=await f.frame();f.advance(2000);const newer=await f.c.capture({game:'generic',match:f.c.status().match});
 await f.c.feedback({game:'generic',match:f.c.status().match,captured_at_ms:newer.captured_at_ms,source_sha256:newer.source_sha256,identity:{game_name:field('游戏甲')}});
 assert.equal((await f.c.feedback({game:'generic',match:f.c.status().match,captured_at_ms:old.captured_at_ms,source_sha256:old.source_sha256,identity:{game_name:field('游戏乙')}})).reason,'reordered_frame');await f.c.close();
});
test('cloud feedback is delivered before final reply, and a new round suppresses the old answer',async()=>{
 let current=true,received=0;
 const agent=createCloudAgent({getToken:async()=> 'fixture',isCurrent:()=>current,getContext:async()=>({}),onObservation:async value=>{assert.equal(value.game,'generic');assert.equal(value.match,'one');received++;current=false;},fetchImpl:async url=>new URL(url).pathname.endsWith('/tasks')?Response.json({task_id:'a'.repeat(32)}):Response.json({status:'completed',cursor:1,reply:'旧局回复',events:[{event:'generic_observation',captured_at_ms:100,source_sha256:'fixture',identity:{}}]})});
 await assert.rejects(agent.ask({game:'generic',match:'one',question:'观察'}),e=>e.status===409);assert.equal(received,1);await agent.close();
});
test('recognized game context reaches tools and scopes guide search without a LoL default',async()=>{
 const current={game:'generic',match:'one',at:1,me:{genericState:{gameName:'游戏甲',gameMode:'模式乙',gameVersion:'1.2',identity:'corroborated'}}};
 assert.equal(cloudContext({current},'generic','one').current_match_state.generic_state.gameName,'游戏甲');
 let query;const search=createWebSearch({fetchImpl:async url=>{query=new URL(url).searchParams.get('q');return new Response('<rss></rss>');}});await search('攻略',current);assert.match(query,/游戏甲 模式乙 1.2/);assert.doesNotMatch(query,/英雄联盟/);
});

test('manual confirmation and new round routes require the local nonce and explicit action',async t=>{
 const f=fixture(),stateDir=await mkdtemp(join(tmpdir(),'jinbao-generic-api-')),values=new Map();
 const credentials={resolve:async k=>values.has(k)?{value:values.get(k)}:undefined,set:async(k,v)=>values.set(k,v),unset:async k=>values.delete(k)};
 const setup=await createSetupServer({stateDir,credentials,port:0,observation:f.c,runtimeId:'standalone',fetchImpl:async()=>Response.json({})});
 t.after(async()=>{await setup.close();await f.c.close();await rm(stateDir,{recursive:true,force:true});});const[base,nonce]=setup.url.split('/#');
 const request=(path,data,authorized=true)=>fetch(base+'/api/observation/'+path,{method:'POST',headers:{'Content-Type':'application/json',...(authorized?{'x-jinbao-setup':nonce}:{})},body:JSON.stringify(data)});
 assert.equal((await request('new-round',{confirmed:true},false)).status,403);
 assert.equal((await request('start',{targetId:'window',authorized:true})).status,200);
 assert.equal((await request('confirm',{game_name:'手动游戏',game_mode:'模式甲'})).status,200);const before=f.c.status().match;
 assert.equal((await request('new-round',{confirmed:false})).status,400);assert.equal(f.c.status().match,before);
 assert.equal((await request('new-round',{confirmed:true})).status,200);assert.notEqual(f.c.status().match,before);assert.equal(f.c.status().identity.confirmed.game_mode,undefined);
});

test('stop during window selection cannot resurrect an observation after selection completes',async()=>{
 const f=fixture();let release,signal;
 f.observer.select=options=>{signal=options.signal;return new Promise(r=>release=r);};
 const starting=f.c.start({targetId:'window',authorized:true});const cancelled=assert.rejects(starting,e=>e.status===409);
 while(!release)await new Promise(r=>setImmediate(r));await f.c.stop();assert.equal(signal.aborted,true);
 release({id:'window',title:'old'});await cancelled;assert.equal(f.c.status().enabled,false);await f.c.close();
});

test('generic round changes reach the real log projection and clear prior chat without losing game identity',async t=>{
 const stateDir=await mkdtemp(join(tmpdir(),'jinbao-generic-projection-'));let overlay;
 const observer={list:async()=>[{id:'window',title:'游戏窗口',foreground:true}],select:async()=>({id:'window',title:'游戏窗口'}),clear(){}};
 const c=createDesktopObservation({stateDir,view:()=>overlay?.view()??{},observer});
 t.after(async()=>{await c.close();await overlay?.close();await rm(stateDir,{recursive:true,force:true,maxRetries:3,retryDelay:100});});
 await c.start({targetId:'window',authorized:true});overlay=await createOverlayService({stateDir,pollMs:20,agentChat:async()=> '本局回答',search:async()=>({results:[]})});
 const wait=async check=>{for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,20));}assert.fail('Projection did not update');};
 await c.confirm({game_name:'用户游戏',game_mode:'旧模式'});await wait(()=>overlay.view().match===c.status().match);
 assert.match(overlay.view().title,/用户游戏/);await overlay.ask('记得这是上一局吗');assert.ok(overlay.view().chatRows.length>0);
 const previous=overlay.view().match;await c.newRound();await wait(()=>overlay.view().match!==previous&&overlay.view().match===c.status().match);
 assert.equal(overlay.view().chatRows.length,0);assert.equal(overlay.view().phase,'InProgress');assert.match(overlay.view().title,/用户游戏/);assert.doesNotMatch(overlay.view().advice,/旧模式|对局 等待对局/);
});
