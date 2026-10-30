import test from 'node:test';import assert from 'node:assert/strict';
import {createAutomaticPacing} from '../automatic-pacing.mjs';
import {createCloudCoach} from '../auto-coach.mjs';
import {agentQuestion} from '../cloud-agent.mjs';
test('coach and background builds share one request per 60 seconds without queuing',async()=>{
 let time=0,calls=0;const gate=createAutomaticPacing({now:()=>time});
 for(let i=0;i<1200;i++){
  time=i*100;for(const topic of ['advice','equipment'])try{await gate.run({topic,automatic:true},async()=>calls++);}catch(e){assert.equal(e.code,'auto_deferred');}
 }
 assert.equal(calls,2);
});
test('failures cool down from completion; speech backpressure defers automatic work but not manual questions',async()=>{
 let time=0,busy=false,calls=0;const gate=createAutomaticPacing({now:()=>time,busy:()=>busy});
 await assert.rejects(gate.run({topic:'advice'},async()=>{calls++;time=20000;throw Error('Failed');}));
 time=60000;await assert.rejects(gate.run({topic:'equipment'},async()=>calls++),e=>e.code==='auto_deferred');
 time=80000;busy=true;await assert.rejects(gate.run({topic:'advice'},async()=>calls++));
 assert.equal(await gate.run({topic:'equipment',priority:'manual'},async()=> '手动回答'),'手动回答');
 busy=false;await gate.run({topic:'equipment'},async()=>calls++);assert.equal(calls,2);
});
test('blocked automatic coach does not read context, consume stages or invoke its model',async()=>{
 let allowed=false,calls=0,reads=0;const current={game:'lol',match:'one',phase:'InProgress',gameSeconds:100,me:{champion:'安妮',level:5},enemies:[],offers:[],ownedAugments:[]};
 const coach=createCloudCoach({now:()=>10000,view:()=>({game:'lol',match:'one',updatedAt:10000}),canRequest:()=>allowed,getContext:async()=>{reads++;return {current};},agent:{ask:async()=>{calls++;return '先清线。';}},publish:async()=>{}});
 await coach.tick();assert.equal(reads,0);assert.equal(calls,0);allowed=true;await coach.tick();assert.equal(calls,1);coach.close();
 assert.match(agentQuestion({question:'当前建议',automatic:true,topic:'advice'}),/40—60字/);
});
