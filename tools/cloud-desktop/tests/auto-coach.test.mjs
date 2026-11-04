import test from'node:test';import assert from'node:assert/strict';import{createCloudCoach}from'../auto-coach.mjs';
test('ranking a concurrent offer does not consume a newly confirmed augment playbook',async()=>{
 let time=10000;const entries=[];
 const current={game:'lol',match:'one',phase:'InProgress',gameSeconds:180,me:{champion:'安妮',level:6,items:[]},allies:[],enemies:[],offers:[],ownedAugments:['旧强化']};
 const coach=createCloudCoach({view:()=>({game:'lol',match:'one',updatedAt:time}),getContext:async()=>({current}),now:()=>time,agent:{ask:async()=> '按全部强化调整打法'},publish:async e=>entries.push(e)});
 await coach.tick();assert.equal(entries.at(-1).key,'postAugment');
 current.offers=['新强化','备选乙','备选丙'];current.ownedAugments.push('新强化');time+=1000;
 await coach.tick();assert.equal(entries.at(-1).key,'augment');
 current.offers=[];time+=1000;await coach.tick();assert.equal(entries.at(-1).key,'postAugment');
 assert.equal(entries.filter(e=>e.key==='postAugment').length,2);coach.close();
});
test('cloud automatic advice uses the same Agent transport, avoids repeat polls and rejects stale replies',async()=>{
 let current={game:'lol',match:'one',phase:'InProgress',gameSeconds:180,me:{champion:'安妮',level:6,items:[]},enemies:[],offers:[],ownedAugments:[]};let time=10000,calls=0;const entries=[];
 const coach=createCloudCoach({view:()=>({game:'lol',match:current.match,updatedAt:time}),getContext:async()=>({current}),now:()=>time,agent:{ask:async()=>{calls++;if(calls===2)current={...current,offers:[{name:'新选项'}]};return'先等队友控制';}},publish:async e=>entries.push(e)});
 await coach.tick();await coach.tick();assert.equal(calls,1);assert.equal(entries.length,1);
 current={...current,offers:[{name:'旧选项'}]};await coach.tick();assert.equal(calls,2);assert.equal(entries.length,1);
 coach.close();await coach.tick();assert.equal(calls,2);
});
test('failed automatic task retries its stage after backoff instead of consuming the milestone',async()=>{
 let time=10000,calls=0;const entries=[];
 const current={game:'lol',match:'one',phase:'InProgress',gameSeconds:180,me:{champion:'安妮',level:6,items:[]},enemies:[],offers:[],ownedAugments:[]};
 const coach=createCloudCoach({view:()=>({game:'lol',match:'one',updatedAt:time}),getContext:async()=>({current}),now:()=>time,
  agent:{ask:async()=>{if(++calls===1)throw Error('Transient service failure');return '先等队友控制';}},publish:async e=>entries.push(e)});
 await coach.tick();await coach.tick();assert.equal(calls,1);
 time+=15001;await coach.tick();assert.equal(calls,2);assert.equal(entries.length,1);
 await coach.tick();assert.equal(calls,2);coach.close();
});

test('a late plan-shaped reply is published with fresh validity instead of dropped',async()=>{
 // Real match: 19 turns completed, each taking 13–58s, and 7 were thrown away because the
 // enemy inventory moved during the turn. That left 2 published advices in a whole game.
 let time=10000;const entries=[];const notes=[];
 let current={game:'lol',match:'one',phase:'InProgress',gameSeconds:180,
  me:{champion:'安妮',level:6,items:[],dead:false},enemies:[{champion:'锐雯',items:[]}],offers:[],ownedAugments:[],
  completedEquipmentEvents:[{at:1,hero:'锐雯',items:['黑色切割者']}]};
 const coach=createCloudCoach({
  view:()=>({game:'lol',match:'one',updatedAt:time}),
  getContext:async()=>({current}),
  now:()=>time,
  trace:event=>{if(event.action)notes.push(event);},
  agent:{ask:async()=>{
   // The enemy finishes another item while the model is still working.
   current={...current,enemies:[{champion:'锐雯',items:[{name:'死亡之舞'}]}]};time+=40000;return '先做中娅沙漏，等锐雯先手';
  }},
  publish:async entry=>entries.push(entry)});
 await coach.tick();
 assert.equal(entries.length,1,'a late but still useful plan must reach the player');
 assert.equal(entries[0].key,'enemyChange');
 assert.ok(entries[0].validity.expiresAt>time,'validity must be re-stamped at publish time');
 assert.ok(notes.some(note=>note.action==='coach_late_published'),'the late publish must be traceable');
 coach.close();
});

test('a late reply tied to a closed window is still dropped',async()=>{
 let time=10000;const entries=[];
 let current={game:'lol',match:'one',phase:'InProgress',gameSeconds:180,
  me:{champion:'安妮',level:6,items:[],dead:false},enemies:[],offers:['甲','乙','丙'],ownedAugments:[]};
 const coach=createCloudCoach({
  view:()=>({game:'lol',match:'one',updatedAt:time}),
  getContext:async()=>({current}),
  now:()=>time,
  agent:{ask:async()=>{
   // The panel rerolled while the model was deciding: recommending 甲 is now wrong.
   current={...current,offers:['丁','戊','己']};time+=40000;return '选甲';
  }},
  publish:async entry=>entries.push(entry)});
 await coach.tick();
 assert.equal(entries.length,0,'a recommendation for an offer that no longer exists must not ship');
 coach.close();
});
