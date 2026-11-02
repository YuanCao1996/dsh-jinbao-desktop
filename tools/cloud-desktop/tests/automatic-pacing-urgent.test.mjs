import test from 'node:test';
import assert from 'node:assert/strict';
import {createAutomaticPacing} from '../automatic-pacing.mjs';

test('a busy voice queue defers ordinary automatic work but never a confirmed-augment turn',async()=>{
 let busy=true,ran=0;
 const pacing=createAutomaticPacing({busy:()=>busy,intervalMs:0,now:()=>Date.now()});
 const ask=urgent=>pacing.run({topic:'advice',automatic:true,...(urgent?{urgent:true}:{})},async()=>{ran++;return 'ok';});

 assert.equal(pacing.canRequest(),false,'the coarse gate still reports blocked while busy');
 await assert.rejects(ask(false),e=>e.code==='auto_deferred'&&e.status===409);
 await pacing.run({topic:'equipment',automatic:true},async()=>'e').catch(()=>{});
 assert.equal(await ask(true),'ok','an urgent turn must not wait for the voice queue');
 assert.equal(ran,1);
});

test('urgency never allows two turns at once',async()=>{
 let release;
 const pacing=createAutomaticPacing({busy:()=>true,intervalMs:0});
 const first=pacing.run({topic:'advice',automatic:true,urgent:true},()=>new Promise(resolve=>{release=resolve;}));
 await new Promise(r=>setTimeout(r,10));
 await assert.rejects(pacing.run({topic:'advice',automatic:true,urgent:true},async()=>'second'),e=>e.code==='auto_deferred');
 release('first');
 assert.equal(await first,'first');
});

test('a manual request is never gated',async()=>{
 const pacing=createAutomaticPacing({busy:()=>true,intervalMs:60000});
 assert.equal(await pacing.run({topic:'chat',priority:'manual'},async()=>'answer'),'answer');
});
