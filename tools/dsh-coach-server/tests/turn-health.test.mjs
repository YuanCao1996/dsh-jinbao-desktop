import test from 'node:test';import assert from 'node:assert/strict';import {createTurnHealth,recoverySessionId,canRetryContext} from '../lib/turn-health.js';import {turnContext} from '../lib/turn-context.js';
test('native compaction failure without a reply permits one recovery; valid reply prevents duplicate retry',()=>{const h=createTurnHealth();h.observe({type:'compaction/end',data:{error:'summary is not smaller'}});assert.equal(h.failedWithoutReply(null),true);assert.equal(h.failedWithoutReply('已提交建议'),false);const error={code:'AGENT_CONTEXT_BLOCKED'};assert.equal(canRetryContext({},error),true);assert.equal(canRetryContext({contextRetried:true},error),false);h.reset();assert.equal(h.failedWithoutReply(null),false);assert.notEqual(recoverySessionId('same-game','new'),recoverySessionId('same-game','old'));});
test('turn payload retains current items, all augments, events and recent chat without resending full history',()=>{const context={current:{game:'lol',match:'one',me:{champion:'安妮',items:[{name:'残疫'}]},enemies:[{champion:'锐雯',items:[{name:'无尽之刃'}]}],ownedAugments:['甲','乙','丙'],events:[{time:'05:20',text:'海克斯选择：甲'}],chat:Array.from({length:20},(_,i)=>({role:'user',text:'问题'+i+'字'.repeat(1000)})),knowledge:[{desc:'长'.repeat(16000)}]},preferences:[],previousMatches:[]};const reduced=turnContext(context);assert.ok(JSON.stringify(reduced).length<9000);assert.equal(reduced.current.me.items[0].name,'残疫');assert.equal(reduced.current.enemies[0].items[0].name,'无尽之刃');assert.deepEqual(reduced.current.ownedAugments,['甲','乙','丙']);assert.match(JSON.stringify(reduced),/海克斯选择/);assert.equal(reduced.current.chat.length,4);assert.equal(context.current.chat.length,20);assert.match(reduced.historyAvailableVia,/game_log_query/);});

test('a recovered native session is resumed after restart without reopening poisoned base history',async()=>{const {mkdtemp}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {loadRecoverySession,saveRecoverySession}=await import('../lib/recovery-session.js');const root=await mkdtemp(join(tmpdir(),'jinbao-recovery-'));assert.equal(loadRecoverySession(root,'coach-test'),'coach-test');saveRecoverySession(root,'coach-test','coach-test-recover-unique');assert.equal(loadRecoverySession(root,'coach-test'),'coach-test-recover-unique');assert.equal(loadRecoverySession(root,'other-game'),'other-game');});

test('final assistant text requires completed native turn and excludes intermediate, failed or reasoning-only messages',()=>{
 const h=createTurnHealth(),emit=(type,data)=>h.observe({type,data});
 const text=()=>emit('assistant/message',{message:{content:[{type:'reasoning',text:'secret'},{type:'text',text:'answer'}]}});
 text();assert.equal(h.chatAnswer(),'');emit('turn/end',{reason:{kind:'completed'}});assert.equal(h.chatAnswer(),'answer');
 h.reset();text();emit('tool/call',{});emit('turn/end',{reason:{kind:'completed'}});assert.equal(h.chatAnswer(),'');
 h.reset();text();emit('turn/end',{reason:{kind:'failed',error:{code:'error'}}});assert.equal(h.chatAnswer(),'');
 h.reset();emit('assistant/message',{message:{content:[{type:'reasoning',text:'secret'}]}});emit('turn/end',{reason:{kind:'completed'}});assert.equal(h.chatAnswer(),'');
});

test('transport 413 recovers context; unrelated failures are visible without resetting context',()=>{
 const h=createTurnHealth();h.observe({type:'turn/end',data:{reason:{kind:'error',error:{code:'INVALID_REQUEST',message:'413 "request too large"'}}}});
 assert.equal(h.failedWithoutReply(null),true);assert.equal(h.chatAnswer(),'');
 h.reset();h.observe({type:'turn/end',data:{reason:{kind:'error',error:{code:'AUTHENTICATION_ERROR',message:'401 invalid key'}}}});
 assert.equal(h.failedWithoutReply(null),false);assert.equal(h.failure().code,'AUTHENTICATION_ERROR');
});

test('ordinary kills enrich context without triggering model turns; objectives remain actionable',async()=>{
 const {LOL_ADAPTER}=await import('../lib/adapters/lol.js');const state=LOL_ADAPTER.createState();
 assert.equal(LOL_ADAPTER.filter.contextOnly({kind:'event',text:'击杀：英雄甲击杀英雄乙'},state),true);
 assert.equal(LOL_ADAPTER.filter.contextOnly({kind:'event',text:'防御塔被摧毁'},state),false);
 assert.equal(LOL_ADAPTER.filter.contextOnly({kind:'event',text:'团灭'},state),false);
 assert.equal(LOL_ADAPTER.filter.contextKey({kind:'event',text:'击杀'}),'lol:recent-event');
});
