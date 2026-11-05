import test from 'node:test';
import assert from 'node:assert/strict';
import {buildLolCoachingPlan, coachingStillCurrent,createAdviceValidity,adviceIsValid} from '../lib/lol-coaching-plan.js';
import {initialOverlayState,applyOverlayEvent,overlayView} from '../../dsh-onboarding/overlay-state.mjs';
import {LOL_ADAPTER as adapter} from '../lib/adapters/lol.js';
import {turnContext} from '../lib/turn-context.js';
import {createMonitor} from '../lib/index.js';
import {createGameMemory} from '../lib/game-memory.js';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const poll = (time, level, items = []) => adapter.log.classify({game:'lol',kind:'state',state:{time,level,items}});
test('death interrupts cooldown once, purchases during death update after debounce, enemy changes retain evidence',()=>{
  const st=adapter.createState();
  const push=(time,extra)=>{const e=adapter.log.classify({kind:'state',state:{time,level:7,dead:false,items:[],enemyItems:[],...extra}});adapter.filter.contextOnly(e,st);return e;};
  push(100,{});
  assert.equal(push(101,{dead:true}).coachTrigger,'death');
  assert.equal(push(102,{dead:true}).coachTrigger,null);
  assert.equal(push(105,{dead:true,items:['残疫']}).coachTrigger,null);
  assert.equal(push(117,{dead:true,items:['残疫']}).coachTrigger,'purchase');
  const change=push(150,{items:['残疫'],enemyItems:['水银之靴']});
  assert.equal(change.coachTrigger,'enemyChange');
  assert.match(change.coachChanges.currentEnemy,/水银之靴/);
  assert.equal(push(151,{items:['残疫'],enemyItems:['水银之靴']}).coachTrigger,null);
  assert.equal(buildLolCoachingPlan([change],{me:{level:7},gameSeconds:150}).stage,'enemyChange');
  assert.equal(coachingStillCurrent([{coachTrigger:'death'}],{me:{dead:false}}),false);
});

test('explicit shop permission opens a purchase task; gold alone never asserts shopping access',()=>{
  const st=adapter.createState();
  for(const [time,canShop,expected] of [[0,false,'opening'],[1,true,'purchase'],[2,true,null]]){
    const e=poll(time,3);e.state.canShop=canShop;adapter.filter.contextOnly(e,st);assert.equal(e.coachTrigger,expected);
  }
  const plan=buildLolCoachingPlan([{coachTrigger:'death',kind:'state',state:{dead:true,time:100}}]);
  assert.equal(plan.stage,'death');assert.match(plan.prompt,/不要断言现在可以买/);
});

test('published advice expires on purchase, respawn, new choices or TTL, but unrelated gold ticks preserve it',()=>{
  const s={match:'m',phase:'InProgress',me:{champion:'安妮',level:7,dead:true,items:[],gold:600},ownedAugments:['甲'],enemies:[],offers:[{name:'乙'}]};
  const validity=createAdviceValidity('death',s,1000);
  assert.equal(adviceIsValid(validity,{...s,me:{...s.me,gold:601}},1001),true);
  assert.equal(adviceIsValid(validity,{...s,me:{...s.me,items:['残疫']}},1001),false);
  assert.equal(adviceIsValid(validity,{...s,me:{...s.me,dead:false}},1001),false);
  assert.equal(adviceIsValid(validity,s,46000),false);
  assert.equal(adviceIsValid(createAdviceValidity('augment',s,1000),{...s,offers:[{name:'丙'}]},1001),false);
  // Identical compact/native snapshots must not falsely invalidate a reply.
  assert.equal(adviceIsValid(createAdviceValidity('death',turnContext({current:s}).current,1000),s,1001),true);
});

test('overlay withdraws obsolete content from battle page and playback while keeping history',()=>{
  const s={...initialOverlayState(),game:'lol',match:'m',phase:'InProgress',me:{champion:'安妮',level:7,dead:true,items:[]}};
  applyOverlayEvent(s,{game:'lol',match:'m',at:Date.now(),broadcast:'下次购买时优先补装备',validity:createAdviceValidity('death',s)},'coach');
  assert.equal(overlayView(s).playback.length,1);
  s.me.dead=false;
  const view=overlayView(s);
  assert.equal(view.playback.length,0);assert.equal(view.revokedPlayback.length,1);
  // Revoked from playback, but the battle page keeps the last text with a staleness
  // marker instead of dropping back to a status label the player cannot act on.
  assert.match(view.advice,/优先补装备/);assert.match(view.advice,/稍早建议，局势已变化/);assert.equal(s.broadcasts.length,1);
  s.me.dead=true;assert.equal(overlayView(s).playback.length,0);
});
test('polls trigger opening and level six once, then material changes with game-time cooldown', () => {
  const store = adapter.createState();
  const opening = poll(10,3);
  assert.equal(adapter.filter.contextOnly(opening,store),false);
  assert.equal(opening.coachTrigger,'opening');
  assert.equal(adapter.filter.contextOnly(poll(12,3),store),true);
  const six = poll(30,6);
  assert.equal(adapter.filter.contextOnly(six,store),false);
  assert.equal(six.coachTrigger,'ultimate');
  assert.equal(adapter.filter.isHighSignal([six],store),true);
  assert.equal(adapter.filter.contextOnly(poll(32,6),store),true);
  assert.equal(adapter.filter.contextOnly(poll(50,6,['残疫']),store),true);
  assert.equal(adapter.filter.contextOnly(poll(106,7,['残疫']),store),false);
  assert.equal(adapter.filter.contextOnly(poll(200,7,['残疫']),store),true);
  const next = poll(0,3);
  assert.equal(adapter.filter.contextOnly(next,store),false);
  assert.equal(next.coachTrigger,'opening');
});

test('champ selection reacts to allied roster and bench changes; compression keeps stats', () => {
  const store = adapter.createState();
  const e={kind:'champ_select',me:{champion:'安妮'},allies:[{champion:'盖伦'}],bench:[{champion:'瑞兹',tier:'T1',winRate:53}]};
  assert.equal(adapter.filter.isFactChanged(e,store,'match'),true);
  assert.equal(adapter.filter.isFactChanged(e,store,'match'),false);
  assert.equal(adapter.filter.isFactChanged({...e,bench:[{champion:'布隆'}]},store,'match'),true);
  const current=turnContext({current:{...e,phase:'ChampSelect'}}).current;
  assert.equal(current.bench[0].winRate,53);
  const plan=buildLolCoachingPlan([e],current);
  assert.equal(plan.stage,'selection');
  assert.match(plan.prompt,/召唤师技能/);
  assert.equal(plan.facts.bench[0].tier,'T1');
});

test('loading, early, ultimate and situation have different tasks based on actual phase/level', () => {
  assert.equal(buildLolCoachingPlan([{kind:'load'}]).stage,'loading');
  assert.equal(buildLolCoachingPlan([{kind:'game_start',me:{level:3}}]).stage,'opening');
  assert.equal(buildLolCoachingPlan([{kind:'state',coachTrigger:'ultimate'}],{me:{level:6},gameSeconds:180}).stage,'ultimate');
  assert.equal(buildLolCoachingPlan([{kind:'load'}],{phase:'InProgress',gameSeconds:500}).stage,'situation');
  assert.match(buildLolCoachingPlan([{kind:'state',coachTrigger:'ultimate'}]).prompt,/不证明已学习大招或冷却结束/);
});

test('augment rerolls use only live choices; confirmation keeps all owned augments and provenance', () => {
  const options=[{name:'甲'},{name:'乙'},{name:'丙'}];
  const e={kind:'augment_offer',options};
  assert.equal(coachingStillCurrent([e],{offers:options}),true);
  assert.equal(coachingStillCurrent([e],{offers:[{name:'丁'},{name:'乙'},{name:'丙'}]}),false);
  assert.equal(coachingStillCurrent([e],{offers:[]}),false);
  const confirmation=adapter.log.classify({kind:'augment_picked',augment:'甲',who:'self',source:'user-confirmed',confidence:'high'});
  assert.match(confirmation.text,/甲/);
  const plan=buildLolCoachingPlan([confirmation],{me:{champion:'安妮',items:['残疫']},ownedAugments:['甲','旧强化'],augmentRounds:[{confirmed:true}],gameSeconds:400});
  assert.equal(plan.stage,'postAugment');
  assert.deepEqual(plan.facts.ownedAugments,['甲','旧强化']);
  assert.equal(plan.facts.selectionEvidence.source,'user-confirmed');
  assert.match(plan.prompt,/下一件成装/);
});

test('late champion selection and ended match replies are suppressed', () => {
  assert.equal(coachingStillCurrent([{kind:'champ_select'}],{phase:'InProgress'}),false);
  assert.equal(coachingStillCurrent([{kind:'state'}],{ended:true}),false);
  assert.equal(coachingStillCurrent([{kind:'state'}],null),true);
});

test('chat-log confirmed own augment triggers build synergy; enemy selection is not treated as ours', () => {
  const current={me:{champion:'安妮'},gameSeconds:300};
  const event={kind:'chat_events',events:[{kind:'augment_picked_chat',champion:'安妮',augment:'甲'}]};
  assert.equal(adapter.filter.isHighSignal([event],adapter.createState()),true);
  assert.equal(buildLolCoachingPlan([event],current).stage,'postAugment');
  event.events[0].champion='锐雯';
  assert.equal(buildLolCoachingPlan([event],current).stage,'situation');
  assert.equal(buildLolCoachingPlan([{kind:'augment_picked',who:'enemy',name:'甲'}],current).stage,'situation');
});

test('adapter passes stage events into native Agent route and removes conflicting 50 character cap', () => {
  const e=adapter.log.classify({kind:'load',mode:'KIWI',me:{champion:'安妮'}});
  const body=adapter.prompt.eventsToBody([e]);
  assert.deepEqual(body._coachEvents,[e]);
  assert.match(body.prompt,/出门装备/);
  assert.doesNotMatch(body.prompt,/≤50字/);
  // 口径统一：不再要求 80—180 字，改为最多两句、总计不超过 60 字
  assert.match(adapter.prompt.eventToBody(e).prompt,/不超过60字/);
});

test('native monitor rebuilds stage context and suppresses a reply when options change during inference', async t => {
  const root=await mkdtemp(join(tmpdir(),'jinbao-stage-'));
  const memory=createGameMemory(root);
  const options=[{name:'甲'},{name:'乙'},{name:'丙'}];
  const current={game:'lol',match:'one',at:1,phase:'InProgress',gameSeconds:180,me:{champion:'安妮',level:6},offers:options,ownedAugments:['旧强化']};
  await memory.snapshot(current);
  const prompts=[];
  const workspace={sessionIds:[],attachSession(id){this.sessionIds.push(id);}};
  const ctx={on:()=>()=>{},get:key=>key==='workspaceRegistry'?{resolveByPath:async()=>workspace}:undefined,
    agentLoop:{createAgent:async(_ctx,config)=>{
      const tools=new Map();
      await config.setup({get:()=>undefined,on:()=>()=>{},tools:{register:tool=>tools.set(tool.name,tool)}});
      const agent={status:'idle',session:{id:config.sessionId},send(message){
        prompts.push(message.content[0].text);agent.status='running';
        setTimeout(async()=>{
          await memory.snapshot({...current,at:2,offers:[{name:'丁'},{name:'乙'},{name:'丙'}]});
          await tools.get('coach_reply').execute({text:'首选甲，配合安妮的控制。'});
          agent.status='idle';
        },10);
      },cancel(){this.status='idle';}};
      return {agent,dispose:async()=>{}};
    }}};
  const monitor=createMonitor(ctx,{sessionCwd:root,diagLogFile:join(root,'diag.log'),liveStateFile:join(root,'state.json'),monitorSessionId:'stage-test',monitorMatch:'one',defaultGame:'lol',coachPreset:'test',monitorStartTimeoutMs:2000,liveTimeoutMs:2000},()=>adapter);
  t.after(()=>monitor.close());
  const event=adapter.log.classify({kind:'augment_offer',options});
  const body={...adapter.prompt.eventsToBody([event]),game:'lol',match_id:'one'};
  assert.equal(await monitor.submitInteraction(event,'one',body),'');
  assert.equal(prompts.length,1);
  assert.match(prompts[0],/旧强化/);
  assert.match(prompts[0],/首选X/);
  // Already stale queued observations never consume another model request.
  assert.equal(await monitor.submitInteraction(event,'one',body),'');
  assert.equal(prompts.length,1);
});

test('objective key events get their own stage, task and short-lived validity', () => {
 const current = { game:'lol', match:'m', phase:'InProgress', gameSeconds:600,
  me:{champion:'安妮',level:11,items:[]}, allies:[], enemies:[], ownedAugments:[], events:[] };
 const cases = [['ace','ace',/推进/], ['turret','turret',/转线|压塔/], ['inhib','inhib',/超级兵/], ['objective','objective',/龙/]];
 for (const [trigger, stage, word] of cases) {
  const plan = buildLolCoachingPlan([{kind:'key_event',coachTrigger:trigger,keyEvent:{name:'X',time:'10:00',text:'t'}}], current);
  assert.equal(plan.stage, stage, trigger);
  assert.match(plan.prompt, word, trigger);
  assert.equal(plan.facts.keyEvent?.name, 'X', trigger);
  const validity = createAdviceValidity(stage, current, 1000);
  assert.equal(validity.expiresAt, 45000 + 1000, stage + ' keeps a short window');
  assert.ok(adviceIsValid(validity, current, 2000), stage + ' stays valid while nothing changes');
  assert.ok(!adviceIsValid(validity, { ...current, allies:[{champion:'锐雯',dead:false}] }, 2000), stage + ' dies when the fight state changes');
 }
});

test('auto-picked augments reach the plan facts so the advice can account for them', () => {
 const current = { game:'lol', match:'m', phase:'InProgress', gameSeconds:600,
  me:{champion:'安妮',level:11,items:[]}, allies:[], enemies:[], ownedAugments:[], revealedAugments:['坦克引擎'], events:[] };
 const plan = buildLolCoachingPlan([{kind:'augment_mutate'}], current);
 assert.equal(plan.stage, 'postAugment');
 assert.deepEqual(plan.facts.autoPickedAugments, ['坦克引擎']);
});

test('the opening build order survives shopping, changes with the champion, and expires',()=>{
  const at=1_000_000;
  const current={
    game:'lol',match:'m1',phase:'Loading',ended:false,ownedAugments:[],offers:[],bench:[],allies:[],enemies:[],
    me:{champion:'安妮',level:1,items:[],canShop:false,championAugments:[]},
  };
  const validity=createAdviceValidity('opening',current,at);
  assert.equal(adviceIsValid(validity,current,at+1_000),true);
  // Buying the first item and an enemy finishing a build do not invalidate a whole-game plan.
  const shopped={...current,me:{...current.me,items:[{name:'增幅典籍',id:1052},{name:'多兰之戒',id:1056}]},
    enemies:[{champion:'锐雯',items:[{name:'黑色切割者',id:3071}],dead:false}]};
  assert.equal(adviceIsValid(validity,shopped,at+60_000),true,'a purchase must not erase the plan');
  // The phase moves on immediately after loading; the plan must survive that too.
  assert.equal(adviceIsValid(validity,{...shopped,phase:'InProgress'},at+90_000),true);
  // Another champion is a different plan.
  assert.equal(adviceIsValid(validity,{...shopped,me:{...shopped.me,champion:'盖伦'}},at+100_000),false);
  // A different match belongs to a different plan.
  assert.equal(adviceIsValid(validity,{...shopped,match:'m2'},at+100_000),false);
  // The plan is good for ten minutes, not for the whole game.
  assert.equal(adviceIsValid(validity,shopped,at+600_001),false);
});
