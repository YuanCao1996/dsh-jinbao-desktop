import test from 'node:test';import assert from 'node:assert/strict';import {createRuntimeRouter}from'../runtime-router.mjs';
test('manual chat preempts background inference, queues safely and mode changes replace the runtime',async()=>{
 let mode='cloud',closed=0;const calls=[];let background;
 const factory=kind=>()=>({async ask(request){calls.push(kind+':'+request.question);if(request.topic==='advice')return new Promise((_resolve,reject)=>{background=reject;});return kind;},async close(){closed++;background?.(Error('cancelled'));background=null;}});
 const router=createRuntimeRouter({getMode:()=>mode,factories:{cloud:factory('cloud'),byok:factory('byok')}});
 try{const auto=router.ask({game:'lol',match:'one',topic:'advice',question:'auto'});const cancelled=assert.rejects(auto);await new Promise(resolve=>setTimeout(resolve,10));assert.equal(await router.ask({game:'lol',match:'one',topic:'chat',question:'manual'}),'cloud');await cancelled;
 mode='byok';await router.reconfigure();assert.equal(await router.ask({game:'lol',match:'one',topic:'chat',question:'local'}),'byok');assert.ok(closed>=2);assert.deepEqual(calls,['cloud:auto','cloud:manual','byok:local']);
 }finally{await router.close();}
});
test('stale queued matches never invoke another game Agent',async()=>{let match='one',release;const calls=[];const router=createRuntimeRouter({getMode:()=> 'cloud',isCurrent:(_g,m)=>m===match,factories:{cloud:()=>({ask:r=>{calls.push(r.match);return new Promise(resolve=>{release=resolve;});},close:async()=>{}})}});const first=router.ask({game:'lol',match:'one',topic:'chat'});const queued=router.ask({game:'lol',match:'one',topic:'chat'});const failures=Promise.all([assert.rejects(first),assert.rejects(queued)]);await new Promise(resolve=>setTimeout(resolve,10));match='two';release('old');await failures;assert.deepEqual(calls,['one']);await router.close();});
