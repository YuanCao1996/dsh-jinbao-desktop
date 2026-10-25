import test from'node:test';import assert from'node:assert/strict';import{createCloudCoach}from'../auto-coach.mjs';
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
