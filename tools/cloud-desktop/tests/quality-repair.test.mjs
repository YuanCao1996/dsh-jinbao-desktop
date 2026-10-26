import test from 'node:test';import assert from 'node:assert/strict';
import{mkdtemp,mkdir,writeFile,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
import{createAdviceValidity,adviceIsValid}from'../../dsh-coach-server/lib/lol-coaching-plan.js';
import{createCloudCoach}from'../auto-coach.mjs';
import{createKnowledgeSearch}from'../../dsh-onboarding/knowledge-search.mjs';
import{createOverlayService,initialOverlayState,applyOverlayEvent,overlayView}from'../../dsh-onboarding/overlay-state.mjs';
import{createAugmentObserver}from'../../lol-companion/augment-observer.mjs';
import{createItemCatalogue,isCompletedItem}from'../../lol-companion/item-policy.mjs';

test('transient empty Top10 and candidate lookups recover without a manual refresh',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jinbao-empty-augment-'));await mkdir(join(dir,'logs'));let top=0,candidate=0;const at=Date.now();
 await writeFile(join(dir,'logs/lol-empty.jsonl'),[{game:'lol',kind:'game_start',t:at,me:{champion:'安妮'},allies:[{champion:'安妮'}]},{game:'lol',kind:'augment_offer',t:at+1,roll:1,options:['珠光护手','甲','乙']}].map(JSON.stringify).join('\n')+'\n');
 const service=await createOverlayService({stateDir:dir,pollMs:10,knowledgeRetryMs:30,search:async q=>{
  if(q.dataset==='aram-ranking')return{results:[{data:{name:'安妮',winRate:53,tier:1}}]};
  if(q.filter?._type==='augments'&&!q.filter.name)return{results:++top===1?[]:[{data:{_type:'augments',champion:'安妮',name:'常驻推荐',rank:2}}]};
  if(q.filter?.name==='珠光护手')return{results:++candidate===1?[]:[{data:{_type:'augments',champion:'安妮',name:'珠光护手',rank:1}}]};
  return{results:[{data:{_type:q.filter?._type??'augments',champion:'安妮',name:q.filter?.name??'其他数据',rank:5}}]};
 }});t.after(async()=>{await service.close();await rm(dir,{recursive:true,force:true});});
 for(let i=0;i<350&&(!service.view().augments.includes('#1 · 珠光护手')||!service.view().augments.includes('#2 · 常驻推荐'));i++)await new Promise(r=>setTimeout(r,10));
 assert.match(service.view().augments,/#1 · 珠光护手/);assert.match(service.view().augments,/#2 · 常驻推荐/);assert.equal(top,2);assert.equal(candidate,2);
});

test('post-augment advice survives unrelated enemy components; selected augment changes still revoke it',()=>{
 const state={game:'lol',match:'one',me:{champion:'安妮',items:[{id:1026,name:'增幅典籍'}]},enemies:[{champion:'锐雯',items:[]}],ownedAugments:['珠光护手']};
 const validity=createAdviceValidity('postAugment',state,1000);state.enemies[0].items.push({id:1036,name:'长剑'});state.me.items.push({id:1026,name:'增幅典籍'});assert.equal(adviceIsValid(validity,state,2000),true);
 state.ownedAugments.push('尤里卡');assert.equal(adviceIsValid(validity,state,2000),false);
});
test('automatic failures and discarded selections produce visible diagnosable status',async()=>{
 let now=1000;const status=[],c={game:'lol',match:'one',gameSeconds:100,me:{champion:'安妮',level:3},enemies:[],offers:[],ownedAugments:[]};
 const coach=createCloudCoach({view:()=>({game:'lol',match:'one',updatedAt:now}),getContext:async()=>({current:c}),now:()=>now,agent:{ask:async()=>{throw Object.assign(Error('failed'),{status:503,code:'history_compaction_incomplete'});}},publishStatus:async v=>status.push(v),publish:async()=>assert.fail('failed task must not publish')});
 await coach.tick();assert.equal(status[0].state,'running');assert.equal(status.at(-1).code,'history_compaction_incomplete');assert.equal(status.at(-1).state,'failed');coach.close();
});
test('knowledge calls serialize, deduplicate and retry empties without caching them permanently',async()=>{
 let calls=0,active=0,maxActive=0;const search=createKnowledgeSearch(async()=>{calls++;maxActive=Math.max(maxActive,++active);await new Promise(r=>setTimeout(r,5));active--;return{results:calls===1?[]:[{data:{winRate:53}}]};},{spacingMs:0});
 const query={game:'lol',query:'安妮'};await Promise.all([search(query),search(query)]);assert.equal(calls,1);await search(query);assert.equal(calls,2);await search(query);assert.equal(calls,2);assert.equal(maxActive,1);search.clear();await search(query);assert.equal(calls,3);
});
test('live empty hero data recovers on retry and completed enemy equipment remains in battle facts',async t=>{
 const stateDir=await mkdtemp(join(tmpdir(),'jinbao-quality-'));await mkdir(join(stateDir,'logs'));let calls=0;
 await writeFile(join(stateDir,'logs/lol-probe.jsonl'),JSON.stringify({game:'lol',kind:'game_start',match:'one',mode:'KIWI',t:Date.now(),me:{champion:'安妮'},allies:[{champion:'安妮'}]})+'\n');
 const service=await createOverlayService({stateDir,pollMs:10,knowledgeRetryMs:20,search:async q=>q.dataset==='aram-ranking'?{results:++calls===1?[]:[{data:{name:'安妮',winRate:53,tier:1}}]}:{results:[]}});t.after(async()=>{await service.close();await rm(stateDir,{recursive:true,force:true});});
 for(let i=0;i<250&&service.view().playerRows[0]?.winRate!==53;i++)await new Promise(r=>setTimeout(r,10));assert.equal(service.view().playerRows[0].winRate,53);assert.equal(calls,2);
});
test('a temporarily hidden selection panel resumes the same round and used rerolls',()=>{
 const output=[],observer=createAugmentObserver(['甲','乙','丙','丁'],e=>output.push(e));const frame=names=>({available:true,foreground:true,width:1920,height:1080,cardLayout:'stacked-title-regions',titleLines:names.map((text,slot)=>({text,slot,x:500+slot*370,y:430})),lines:[]});
 observer.observe(frame(['甲','乙','丙']));observer.observe(frame(['丁','乙','丙']));observer.observe(frame(['丁','乙','丙']));for(let i=0;i<5;i++)observer.observe(frame([]));assert.equal(output.at(-1).kind,'augment_offer_closed');observer.observe(frame(['丁','乙','丙']));assert.equal(output.at(-1).roll,1);assert.equal(output.at(-1).reopened,true);assert.equal(output.at(-1).options[0].rerollsUsed,1);
});
test('component changes are hidden but enemy completed items produce a scoped event, with full raw inventory preserved',()=>{
 const state=initialOverlayState(),emit=(kind,t,items)=>applyOverlayEvent(state,{game:'lol',kind,t,me:{champion:'安妮'},enemies:[{champion:'锐雯',items}]},'one');
 emit('game_start',1,[{id:1036,name:'长剑'}]);emit('state',2,[{id:1036,name:'长剑',count:2}]);assert.equal(state.events.length,0);emit('state',3,[{id:3031,name:'无尽之刃'},{id:1036,name:'长剑'}]);assert.match(overlayView(state).events,/无尽之刃/);assert.doesNotMatch(overlayView(state).events,/长剑/);assert.equal(state.enemies[0].items.length,2);assert.deepEqual(state.completedEquipmentEvents[0].items,['无尽之刃']);
 const enrich=createItemCatalogue([{id:1,name:'新组件',into:[2],price:1000},{id:2,name:'新成装',from:[1],into:[],price:3000}]);assert.equal(isCompletedItem(enrich({id:1,name:'新组件'})),false);assert.equal(isCompletedItem(enrich({id:2,name:'新成装'})),true);
});
