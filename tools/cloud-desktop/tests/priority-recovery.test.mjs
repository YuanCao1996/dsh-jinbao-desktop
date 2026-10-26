import test from 'node:test';import assert from 'node:assert/strict';
import {createRuntimeRouter} from '../runtime-router.mjs';
import {createCloudCoach} from '../auto-coach.mjs';
import {createEquipmentCoach} from '../../dsh-onboarding/equipment-context.mjs';
import {initialOverlayState} from '../../dsh-onboarding/overlay-state.mjs';
import {createCloudAgent} from '../cloud-agent.mjs';

test('normal shutdown aborts a pending cloud handoff wait',async()=>{
 let started,waiting,cleanupAborted=false;const start=new Promise(r=>started=r),wait=new Promise(r=>waiting=r);let cleanup=false;
 const agent=createCloudAgent({getToken:async()=> 'fixture',getContext:async()=>({}),onProgress:e=>{if(e.event==='cancellation_wait')cleanup=true;},fetchImpl:async(url,o)=>{const path=new URL(url).pathname;if(path.endsWith('/tasks'))return Response.json({task_id:'a'.repeat(32)});if(path.endsWith('/cancel'))return Response.json({status:'running'});if(cleanup)waiting();else started();return new Promise((_r,reject)=>o.signal.addEventListener('abort',()=>{if(cleanup)cleanupAborted=true;reject(o.signal.reason);},{once:true}));}});
 const task=agent.ask({game:'lol',match:'one',question:'auto'}),failed=assert.rejects(task);await start;const handoff=agent.close({reason:'preempt'});await wait;await agent.close();await handoff;await failed;assert.equal(cleanupAborted,true);
});

test('manual cloud handoff waits for a terminal worker instead of trusting cancel acknowledgement',async()=>{
 let creates=0,release,markPolling;const polling=new Promise(r=>markPolling=r),events=[];
 const host=async(url,options)=>{const path=new URL(url).pathname;if(path.endsWith('/tasks')){creates++;return Response.json({task_id:(creates===1?'a':'b').repeat(32)});}if(path.endsWith('/cancel'))return Response.json({status:'running'});if(path.includes('b'.repeat(32)))return Response.json({status:'completed',cursor:1,events:[],reply:'聊天成功'});if(options.signal.aborted)throw options.signal.reason;
  if(events.some(e=>e.event==='cancellation_wait'))return new Promise(resolve=>release=()=>resolve(Response.json({status:'cancelled',cursor:2,events:[]})));
  markPolling();return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
 };
 const progress=e=>events.push(e),router=createRuntimeRouter({getMode:()=> 'cloud',onEvent:progress,factories:{cloud:()=>createCloudAgent({getToken:async()=> 'fixture',getContext:async()=>({}),onProgress:progress,fetchImpl:host})}});
 try{const auto=router.ask({game:'lol',match:'one',topic:'advice',question:'后台建议'}),failed=assert.rejects(auto,e=>e.code==='agent_preempted');await polling;const chat=router.ask({game:'lol',match:'one',topic:'chat',question:'手动提问'});for(let i=0;!release&&i<100;i++)await new Promise(r=>setTimeout(r,2));assert.ok(release,'server terminal poll must start');assert.equal(creates,1,'new model task must not be created while old worker runs');release();assert.equal(await chat,'聊天成功');await failed;assert.equal(creates,2);}
 finally{release?.();await router.close();}
});

test('a full manual queue never discards existing user questions',async()=>{
 let release;const calls=[];const router=createRuntimeRouter({getMode:()=> 'cloud',maxQueue:1,factories:{cloud:()=>({ask:r=>{calls.push(r.question);return r.question==='active'?new Promise(resolve=>release=resolve):Promise.resolve(r.question);},close:async()=>release?.('closed')})}});
 try{const first=router.ask({topic:'chat',question:'active'});while(!release)await new Promise(r=>setTimeout(r,1));const queued=router.ask({topic:'chat',question:'queued'});await assert.rejects(router.ask({topic:'chat',question:'overflow'}),e=>e.status===409);await assert.rejects(router.ask({topic:'advice',question:'background'}),e=>e.status===409);release('active');assert.equal(await first,'active');assert.equal(await queued,'queued');assert.deepEqual(calls,['active','queued']);}finally{await router.close();}
});

test('interrupted equipment recommendation retries without the normal failure cooldown',async()=>{
 let time=10000,calls=0;const s=initialOverlayState();Object.assign(s,{game:'lol',match:'one',matchStartedAt:1,at:time,me:{champion:'安妮',items:[{name:'残疫'}]}});
 const coach=createEquipmentCoach({getState:()=>s,now:()=>time,debounceMs:0,cooldownMs:30000,save:async()=>{},agentChat:async()=>{if(++calls===1)throw Object.assign(Error('preempted'),{code:'agent_preempted'});return '恢复出装建议';}});
 try{coach.tick();await new Promise(r=>setImmediate(r));assert.match(s.equipmentStatus,/手动请求/);time+=999;coach.tick();assert.equal(calls,1);time++;coach.tick();await new Promise(r=>setImmediate(r));assert.equal(calls,2);assert.equal(s.equipment,'恢复出装建议');}finally{coach.close();}
});
test('equipment interruption also releases cooldown when inventory changes before cancellation settles',async()=>{
 let time=10000,calls=0;const s=initialOverlayState();Object.assign(s,{game:'lol',match:'one',matchStartedAt:1,at:time,me:{champion:'安妮',items:[{name:'残疫'}]}});
 const coach=createEquipmentCoach({getState:()=>s,now:()=>time,debounceMs:0,cooldownMs:30000,save:async()=>{},agentChat:async()=>{if(++calls===1)throw Object.assign(Error('preempted'),{code:'agent_preempted'});return '按新装备继续推荐';}});
 try{coach.tick();s.me.items.push({name:'法师之靴'});await new Promise(r=>setImmediate(r));time+=1000;coach.tick();await new Promise(r=>setImmediate(r));assert.equal(calls,2);assert.equal(s.equipment,'按新装备继续推荐');}finally{coach.close();}
});
test('equipment response arriving after match end cannot publish new strategy',async()=>{
 let resolve,published=0;const s=initialOverlayState();Object.assign(s,{game:'lol',match:'one',matchStartedAt:1,at:10000,me:{champion:'安妮',items:[{name:'残疫'}]}});
 const coach=createEquipmentCoach({getState:()=>s,now:()=>10000,debounceMs:0,cooldownMs:0,save:async()=>{},onAdvice:async()=>published++,agentChat:()=>new Promise(r=>resolve=r)});
 try{coach.tick();s.ended=true;resolve('过时的出装建议');await new Promise(r=>setImmediate(r));assert.equal(published,0);assert.notEqual(s.equipment,'过时的出装建议');}finally{coach.close();}
});

test('full automatic queue makes room for manual chat and reports normal preemption',async()=>{
 let cancel,opened=0;const calls=[],events=[];
 const router=createRuntimeRouter({getMode:()=> 'cloud',onEvent:e=>events.push(e),maxQueue:2,factories:{cloud:()=>{const first=++opened===1;return{ask:r=>{calls.push(r.question);return first?new Promise((_resolve,reject)=>cancel=reject):Promise.resolve(r.question);},close:async()=>cancel?.(Error('cancelled'))};}}});
 try{const active=router.ask({topic:'advice',question:'active'}),activeFailure=assert.rejects(active,e=>e.code==='agent_preempted');while(!cancel)await new Promise(r=>setTimeout(r,1));const kept=router.ask({topic:'advice',question:'kept'});const evicted=router.ask({topic:'advice',question:'evicted'}),evictedFailure=assert.rejects(evicted,e=>e.code==='agent_preempted');assert.equal(await router.ask({topic:'chat',question:'manual'}),'manual');await Promise.all([activeFailure,evictedFailure]);assert.equal(await kept,'kept');assert.deepEqual(calls,['active','manual','kept']);assert.equal(events.filter(e=>e.event==='task_cancelled').length,2);}
 finally{await router.close();}
});

test('manual interruption resumes the pending coaching milestone after a short retry',async()=>{
 let time=10000,calls=0;const statuses=[],published=[];
 const current={game:'lol',match:'one',phase:'InProgress',gameSeconds:180,me:{champion:'安妮',level:6,items:[]},enemies:[],offers:[],ownedAugments:[]};
 const coach=createCloudCoach({view:()=>({game:'lol',match:'one',updatedAt:time}),getContext:async()=>({current}),now:()=>time,agent:{ask:async()=>{if(++calls===1)throw Object.assign(Error('manual preemption'),{status:409,code:'agent_preempted'});return '恢复后的策略建议';}},publish:async e=>published.push(e),publishStatus:async e=>statuses.push(e)});
 try{await coach.tick();assert.equal(statuses.at(-1).state,'interrupted');time+=999;await coach.tick();assert.equal(calls,1);time++;await coach.tick();assert.equal(calls,2);assert.equal(published.length,1);assert.equal(statuses.at(-1).state,'published');}finally{coach.close();}
});
