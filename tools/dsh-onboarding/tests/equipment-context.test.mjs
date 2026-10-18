import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initialOverlayState,applyOverlayEvent,overlayView,createOverlayService} from '../overlay-state.mjs';
import {equipmentContext,updateAugmentRecommendations,createEquipmentCoach} from '../equipment-context.mjs';
import {createGameMemory} from '../../dsh-coach-server/lib/game-memory.js';
import {buildGameChatMessage} from '../../dsh-coach-server/lib/chat-bridge.js';
const row=(name,rank)=>({_type:'augments',champion:'安妮',name,rank});

test('build facts retain every owned augment and per-round best assumptions; rerolls and confirmed choices replace assumptions',()=>{
 const s=initialOverlayState();let at=1;
 const emit=e=>applyOverlayEvent(s,{game:'lol',t:++at,...e},'one');
 emit({kind:'game_start',me:{champion:'安妮',items:[{name:'残疫'}]},enemies:[{champion:'锐雯',items:[{name:'无尽之刃'}]}]});
 emit({kind:'augment_picked',who:'self',name:'已拥有强化'});
 emit({kind:'augment_offer',roll:1,options:['甲','乙','丙']});updateAugmentRecommendations(s,[row('甲',7),row('乙',2)]);
 assert.equal(equipmentContext(s).assumedAugments[0].name,'乙');
 emit({kind:'augment_offer',roll:1,reroll:true,options:['甲','丁','丙']});assert.equal(equipmentContext(s).assumedAugments.length,0);
 updateAugmentRecommendations(s,[row('甲',7),row('丁',1)]);emit({kind:'augment_offer_closed',roll:1});
 emit({kind:'augment_offer',roll:2,options:['戊','己','庚']});updateAugmentRecommendations(s,[row('戊',3)]);
 let facts=equipmentContext(s);assert.deepEqual(facts.confirmedAugments,['已拥有强化']);assert.deepEqual(facts.assumedAugments.map(a=>a.name),['丁','戊']);
 emit({kind:'augment_mutate',who:'enemy',augment:'己'});assert.equal(equipmentContext(s).assumedAugments.length,2);
 emit({kind:'augment_mutate',who:'self',augment:'己',confidence:'low'});assert.equal(equipmentContext(s).assumedAugments.length,2);
 emit({kind:'augment_mutate',who:'self',augment:'己',confidence:'high'});
 facts=equipmentContext(s);assert.deepEqual(facts.confirmedAugments,['已拥有强化','己']);assert.deepEqual(facts.assumedAugments.map(a=>a.name),['丁']);
 assert.equal(facts.enemies[0].items[0].name,'无尽之刃');assert.doesNotMatch(overlayView(s).equipment,/无尽之刃|敌方装备/);
});

test('automatic build task is debounced, rate limited, uses enemy items and all augments, and rejects replies from old facts',async()=>{
 let time=10000,s=initialOverlayState(),resolve;const calls=[];
 Object.assign(s,{game:'lol',match:'one',matchStartedAt:1,at:time,me:{champion:'安妮',items:[{name:'残疫'}]},enemies:[{champion:'锐雯',items:[{name:'无尽之刃'}]}],ownedAugments:['甲','乙']});
 const coach=createEquipmentCoach({getState:()=>s,now:()=>time,debounceMs:100,cooldownMs:1000,save:async()=>{},agentChat:request=>{calls.push(request);return new Promise(r=>resolve=r);}});
 coach.tick();assert.equal(calls.length,0);time+=100;coach.tick();assert.equal(calls.length,1);
 assert.match(calls[0].question,/无尽之刃/);assert.match(calls[0].question,/"confirmedAugments":\["甲","乙"\]/);
 s.me.items.push({name:'法师之靴'});resolve('过期建议');await new Promise(r=>setImmediate(r));assert.notEqual(s.equipment,'过期建议');
 coach.tick();time+=100;coach.tick();assert.equal(calls.length,1);time+=900;coach.tick();assert.equal(calls.length,2);
 resolve('下一件优先购买推荐装备');await new Promise(r=>setImmediate(r));assert.equal(s.equipment,'下一件优先购买推荐装备');
 time+=2000;coach.tick();assert.equal(calls.length,2,'unchanged equipment never repeats model calls');
 s.me.items.push({name:'帽子'});coach.tick();time+=1000;coach.tick();assert.equal(calls.length,3);
 s=initialOverlayState();resolve('跨局旧建议');await new Promise(r=>setImmediate(r));assert.notEqual(s.equipment,'跨局旧建议');coach.close();
});

test('weighted team samples require five valid heroes per side and do not include the bench; status belongs in battle text',()=>{
 const s=initialOverlayState();s.game='lol';s.gameSeconds=512;s.me={champion:'我0',level:11,k:2,d:3,a:8,gold:1200};
 s.allies=Array.from({length:5},(_,i)=>({champion:'我'+i}));s.enemies=Array.from({length:5},(_,i)=>({champion:'敌'+i}));s.bench=[{champion:'备选'}];
 const rows=[...s.allies.map((p,i)=>({_viewKind:'hero',name:p.champion,winRate:50+i,tier:'T2'})),...s.enemies.map((p,i)=>({_viewKind:'hero',name:p.champion,winRate:40+i,tier:'T2'})),{_viewKind:'hero',name:'备选',winRate:100}];
 let v=overlayView(s,{rows});assert.equal(v.teamWinRates,'加权样本 · 我方 52%｜敌方 42%');
 assert.match(v.advice,/对局 08:32 · 我0 · Lv11 · 2\/3\/8 · 金币 1200/);
 v=overlayView(s,{rows:rows.slice(1)});assert.match(v.teamWinRates,/我方 待补齐 4\/5/);assert.match(v.teamWinRates,/敌方 42%/);
});

test('event page timeline reaches chat prompt even after oversized context is reduced',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jinbao-event-prompt-')),memory=createGameMemory(dir);
 const s=initialOverlayState();Object.assign(s,{game:'lol',mode:'KIWI',match:'one',at:1,me:{champion:'安妮',oversized:'大'.repeat(20000)},events:[{time:'03:56',text:'安妮购买装备：残疫'},{time:'05:20',text:'海克斯选择：自己 · 珠光护手'}]});
 await memory.snapshot(s);const context=await memory.context('lol','one');const message=buildGameChatMessage('怎么出装',context);
 assert.match(message,/【事件时间线】/);assert.match(message,/安妮购买装备：残疫/);assert.match(message,/05:20/);assert.match(message,/珠光护手/);assert.ok(JSON.stringify(context).length<=16000);
});

test('live overlay automatically updates equipment through the shared Agent bridge without adding fake user chat',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jinbao-live-build-'));await mkdir(join(dir,'logs'));
 let at=Date.now();const logs=[{kind:'game_start',me:{champion:'安妮',items:[{name:'残疫'}]},enemies:[{champion:'锐雯',items:[{name:'无尽之刃'}]}]},
  {kind:'augment_picked',who:'self',name:'已拥有强化'},{kind:'augment_offer',roll:1,options:['甲','乙','丙']}];
 await writeFile(join(dir,'logs/live.jsonl'),logs.map(e=>JSON.stringify({game:'lol',t:++at,...e})).join('\n')+'\n');
 const calls=[];const service=await createOverlayService({stateDir:dir,pollMs:10,equipmentDebounceMs:30,equipmentCooldownMs:1000,
  agentChat:async q=>{calls.push(q);return '下一件优先购买装备甲，暂按强化乙考虑。';},
  search:async q=>({results:q.filter?._type==='augments'?[{data:row('乙',1)}]:[]})});t.after(service.close);
 for(let i=0;i<200&&!service.view().equipment.includes('下一件优先购买');i++)await new Promise(r=>setTimeout(r,10));
 assert.match(service.view().equipment,/下一件优先购买/);assert.match(service.view().equipment,/待确认的强化推测/);
 assert.equal(calls.length,1);assert.match(calls[0].question,/无尽之刃/);assert.match(calls[0].question,/已拥有强化/);assert.match(calls[0].question,/"name":"乙"/);
 assert.doesNotMatch(service.view().chat,/自动出装建议任务/);assert.match(service.view().augments,/尚未收到强化选择日志|已拥有强化/);
});
