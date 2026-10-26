import test from 'node:test';import assert from 'node:assert/strict';
import{mkdtemp,mkdir,writeFile}from'node:fs/promises';import{join}from'node:path';import{tmpdir}from'node:os';
import{createSetupServer}from'../../dsh-onboarding/server.mjs';import{createRuntimeRouter}from'../runtime-router.mjs';import{createCloudCoach}from'../auto-coach.mjs';import{createCloudAgent,cloudContext}from'../cloud-agent.mjs';
import{initialOverlayState,applyOverlayEvent}from'../../dsh-onboarding/overlay-state.mjs';
test('actual default chat HTTP request preempts automatic advice instead of waiting behind it',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jinbao-priority-'));let cancel;const requests=[];
 const router=createRuntimeRouter({getMode:()=> 'cloud',factories:{cloud:()=>({ask:request=>{requests.push(request);return request.topic==='advice'?new Promise((_r,reject)=>{cancel=reject;}):Promise.resolve('手动聊天已回复');},close:async()=>{cancel?.(Error('preempted'));cancel=null;}})}});
 const values=new Map();const credentials={resolve:async k=>values.has(k)?{value:values.get(k)}:undefined,set:async(k,v)=>values.set(k,v),unset:async k=>values.delete(k)};
 const setup=await createSetupServer({stateDir:dir,port:0,credentials,cloudAgent:router,runtimeId:'standalone',fetchImpl:async()=>Response.json({})});t.after(async()=>{await setup.close();await router.close();});
 const auto=router.ask({game:'lol',match:'waiting',topic:'advice',question:'后台建议'}),aborted=assert.rejects(auto);for(let i=0;!cancel&&i<50;i++)await new Promise(r=>setTimeout(r,10));
 const [base,nonce]=setup.url.split('/#');const response=await fetch(base+'/api/overlay/ask',{method:'POST',headers:{'x-jinbao-setup':nonce,'Content-Type':'application/json'},body:JSON.stringify({question:'hi'}),signal:AbortSignal.timeout(3000)});
 assert.equal(response.status,200);assert.equal((await response.json()).answer,'手动聊天已回复');await aborted;assert.equal(requests.at(-1).topic,'chat');assert.equal(requests.at(-1).priority,'manual');
 const view=await(await fetch(base+'/api/overlay',{headers:{'x-jinbao-setup':nonce}})).json();assert.equal(view.chatRows.filter(r=>r.role==='assistant').length,1);
});
test('manual request arriving during runtime startup cancels unopened automatic work',async()=>{
 let release,created=0,autoCalls=0;const router=createRuntimeRouter({getMode:()=> 'cloud',factories:{cloud:async()=>{if(++created===1)await new Promise(r=>release=r);return{ask:async r=>{if(r.topic==='advice')autoCalls++;return 'reply';},close:async()=>{}};}}});
 const auto=router.ask({topic:'advice'}),aborted=assert.rejects(auto);while(!release)await new Promise(r=>setTimeout(r,1));const manual=router.ask({topic:'equipment',priority:'manual'});release();assert.equal(await manual,'reply');await aborted;assert.equal(autoCalls,0);await router.close();
});
test('preempted native runtime finishes closing before another instance resumes its session',async()=>{
 let cancel,retire,created=0;const router=createRuntimeRouter({getMode:()=> 'cloud',factories:{cloud:()=>{created++;return{ask:async r=>r.topic==='advice'?new Promise((_r,reject)=>cancel=reject):'manual',close:async()=>{cancel?.(Error('preempted'));await new Promise(r=>retire=r);}};}}});
 const auto=router.ask({topic:'advice'}),aborted=assert.rejects(auto);while(!cancel)await new Promise(r=>setTimeout(r,1));const manual=router.ask({topic:'chat'});await new Promise(r=>setTimeout(r,20));assert.equal(created,1);retire();assert.equal(await manual,'manual');await aborted;
 retire=null;const ending=router.close();while(!retire)await new Promise(r=>setTimeout(r,1));retire();await ending;
});
test('battle advice refreshes after expiry even without inventory changes and loading is not a finished match',async()=>{
 let time=10000,current={game:'lol',match:'one',phase:'InProgress',gameSeconds:180,me:{champion:'安妮',level:6,items:[]},enemies:[],offers:[],ownedAugments:[]};const entries=[];
 const coach=createCloudCoach({view:()=>({game:'lol',match:current.match,updatedAt:time}),getContext:async()=>({current}),now:()=>time,agent:{ask:async()=> '等队友控制后再接大招'},publish:async e=>entries.push(e)});
 await coach.tick();time+=90001;current.gameSeconds+=91;await coach.tick();assert.equal(entries.length,2);await coach.tick();assert.equal(entries.length,2);coach.close();
 const state=initialOverlayState();Object.assign(state,{game:'lol',match:'select',at:1,phase:'ChampSelect'});applyOverlayEvent(state,{game:'lol',match:'select',kind:'champ_select_end',t:2},'lol');assert.equal(state.phase,'Loading');assert.equal(state.ended,false);
 let prompt;const loading=createCloudCoach({view:()=>({game:'lol',match:'load',updatedAt:time}),getContext:async()=>({current:{...current,match:'load',phase:'Loading',gameSeconds:null}}),now:()=>time,agent:{ask:async r=>{prompt=r.question;return '加载页建议';}},publish:async e=>entries.push(e)});await loading.tick();assert.match(prompt,/出门装备/);assert.equal(entries.at(-1).key,'loading');loading.close();
});
test('cloud equipment preserves task instructions and confirmed versus assumed augments in bounded tool facts',async()=>{
 const current={game:'lol',match:'one',at:1,me:{champion:'安妮',canShop:false,items:[{name:'残疫',count:1,raw:'private-large-metadata'.repeat(10000)}]},ownedAugments:['已确认'],augmentRounds:[{id:1,confirmed:[],recommended:'推测强化',options:['推测强化']}]};let body;
 const agent=createCloudAgent({getToken:async()=> 'token',getContext:async()=>({current}),fetchImpl:async(url,o)=>{if(new URL(url).pathname.endsWith('/tasks')){body=JSON.parse(o.body);return Response.json({task_id:'a'.repeat(32)});}return Response.json({status:'completed',cursor:1,reply:'下一件法穿',events:[]});}});
 await agent.ask({game:'lol',match:'one',topic:'equipment',question:'【自动出装建议任务】推测不能当作拥有，只用 coach_reply 提交最终建议。\n【装备决策事实 JSON】\n'+'大'.repeat(30000)});
 assert.match(body.message,/推测不能当作拥有/);assert.doesNotMatch(body.message,/coach_reply|大/);assert.ok(body.message.length<2000);assert.equal(body.context.current_match_state.me.canShop,false);assert.ok(Buffer.byteLength(JSON.stringify(body.context))<24000);assert.doesNotMatch(JSON.stringify(body.context),/private-large-metadata/);
 assert.deepEqual(body.context.current_match_state.equipment_decision.confirmedAugments,['已确认']);assert.equal(body.context.current_match_state.equipment_decision.assumedAugments[0].name,'推测强化');await agent.close();
});
test('poll disconnect retries the same cloud task; timeout is reported separately and cancels it',async()=>{
 let creates=0,polls=0,cancelled=false;const options={getToken:async()=> 'token',getContext:async()=>({}),pollMs:1};
 const agent=createCloudAgent({...options,fetchImpl:async(url)=>{const p=new URL(url).pathname;if(p.endsWith('/tasks')){creates++;return Response.json({task_id:'a'.repeat(32)});}if(++polls===1)throw Error('transient disconnect');return Response.json({status:'completed',cursor:1,reply:'已恢复',events:[]});}});
 assert.equal(await agent.ask({game:'lol',match:'one',question:'hi'}),'已恢复');assert.equal(creates,1);assert.equal(polls,2);await agent.close();
 const slow=createCloudAgent({...options,timeoutMs:30,fetchImpl:async(url,o)=>{const p=new URL(url).pathname;if(p.endsWith('/tasks'))return Response.json({task_id:'b'.repeat(32)});if(p.endsWith('/cancel')){cancelled=true;return Response.json({});}return new Promise((_r,reject)=>o.signal.addEventListener('abort',()=>reject(o.signal.reason),{once:true}));}});
 await assert.rejects(slow.ask({game:'lol',match:'one',question:'hi'}),e=>e.status===504);assert.equal(cancelled,true);await slow.close();
});
