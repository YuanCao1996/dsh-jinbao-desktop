import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initialOverlayState,applyOverlayEvent,overlayView,createOverlayService} from '../overlay-state.mjs';
import {praiseText,settlePraise,whoKilled,PRAISE_SETTLE_MS,PRAISE_MAX_WAIT_MS} from '../multikill-praise.mjs';
import {createSpeech} from '../../cloud-desktop/speech.mjs';

// Anchored near real time: overlayView revokes playback entries whose expiresAt has
// already passed against Date.now(), so a fixed historical constant would be dropped.
const START=Date.now()-5_000;
const ME='我#1234';
function board({allies=[]}={}){
  const state=initialOverlayState();
  applyOverlayEvent(state,{game:'lol',match:'m1',t:START,kind:'game_start',
    me:{champion:'安妮',riotId:ME},allies}, 'm1');
  return state;
}
const kill=(state,{streak,killer=ME,at})=>applyOverlayEvent(state,
  {game:'lol',match:'m1',t:at,kind:'event',name:'Multikill',KillStreak:streak,killer}, 'm1');
const praises=state=>state.broadcasts.filter(reply=>reply.praise);

test('every level and every role has its own praise; teammates only get quadra and penta',()=>{
  const self=new Set();
  for(const level of [2,3,4,5]){
    const text=praiseText({streak:level});
    assert.ok(text,`self level ${level} needs praise`);
    assert.ok(text.length<=24,`self level ${level} must stay speakable`);
    assert.ok(!self.has(text),'self levels must not reuse a line');
    self.add(text);
  }
  // Tone really changes with the selected mentor.
  assert.notEqual(praiseText({streak:5,role:'jinbao'}),praiseText({streak:5,role:'wangbatian'}));
  assert.notEqual(praiseText({streak:4,role:'liurufeng'}),praiseText({streak:4,role:'tiezhi'}));
  for(const role of ['jinbao','liurufeng','wangbatian','tiezhi']){
    assert.ok(praiseText({streak:5,role}),`role ${role} needs a penta line`);
  }
  // Teammates: quadra/penta yes, triple no.
  assert.equal(praiseText({streak:3,side:'ally',hero:'锐雯'}),'','an ally triple kill is not praised');
  assert.ok(praiseText({streak:4,side:'ally',hero:'锐雯'}).includes('锐雯'));
  assert.ok(praiseText({streak:5,side:'ally',hero:'锐雯'}).includes('锐雯'));
  assert.ok(!praiseText({streak:4,side:'ally'}).includes('{hero}'),'a missing hero name must not leak the placeholder');
  assert.equal(praiseText({streak:1}),'');
  assert.equal(praiseText({streak:6}),'');
});

test('own multi-kill is praised once at the highest level of the chain',()=>{
  const state=board();
  kill(state,{streak:2,at:START+1000});
  assert.equal(settlePraise(state,START+1000+PRAISE_SETTLE_MS-1),false,'must wait for the chain to settle');
  kill(state,{streak:3,at:START+2000});
  kill(state,{streak:5,at:START+3500});
  assert.equal(settlePraise(state,START+3500+PRAISE_SETTLE_MS),true);
  assert.equal(praises(state).length,1);
  assert.equal(praises(state)[0].streak,5);
  assert.equal(praises(state)[0].praiseSide,'self');
  assert.equal(praises(state)[0].priority,2);
  assert.equal(settlePraise(state,START+60_000),false,'a settled chain is never re-praised');
  assert.equal(praises(state).length,1);
});

test('the praise reaches the overlay playback and is marked as praise for speech',()=>{
  const state=board();
  kill(state,{streak:4,at:START+1000});
  settlePraise(state,START+1000+PRAISE_SETTLE_MS);
  const praise=overlayView(state).playback.filter(row=>row.topic==='praise');
  assert.equal(praise.length,1);
  assert.match(praise[0].text,/四杀/);
});

test('an ally quadra kill is praised with the champion name, a double kill is not',()=>{
  const ally={champion:'锐雯',riotId:'队友#9999'};
  const state=board({allies:[ally]});
  kill(state,{streak:2,killer:'队友#9999',at:START+1000});
  assert.equal(settlePraise(state,START+1000+PRAISE_SETTLE_MS),false,'ally double kills stay quiet');
  kill(state,{streak:4,killer:'队友#9999',at:START+5000});
  assert.equal(settlePraise(state,START+5000+PRAISE_SETTLE_MS),true);
  const praise=praises(state);
  assert.equal(praise.length,1);
  assert.equal(praise[0].praiseSide,'ally');
  assert.equal(praise[0].praiseHero,'锐雯');
  assert.match(praise[0].text,/锐雯/);
});

test('an enemy multi-kill is never praised',()=>{
  const state=board();
  kill(state,{streak:5,killer:'对面#0001',at:START+1000});
  assert.deepEqual(state.praiseChains,{});
  assert.equal(settlePraise(state,START+1001+PRAISE_SETTLE_MS),false);
  assert.equal(praises(state).length,0);
});

test('without a known self identity no praise is invented',()=>{
  const state=initialOverlayState();
  applyOverlayEvent(state,{game:'lol',match:'m1',t:START,kind:'game_start',me:{champion:'安妮'}},'m1');
  kill(state,{streak:3,at:START+1000});
  assert.deepEqual(state.praiseChains,{});
  assert.equal(whoKilled(state,{killer:'谁#1'}).side,'other');
});

test('a stalled chain still gets its praise instead of being dropped',()=>{
  const state=board();
  kill(state,{streak:2,at:START+1000});
  assert.equal(settlePraise(state,START+1000+PRAISE_MAX_WAIT_MS),true);
  assert.equal(praises(state).length,1);
});

test('praise bypasses the 45s quiet window but leaves tactical advice room again after 15s',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'jinbao-praise-'));
  let time=START;
  const view={game:'lol',match:'one',updatedAt:time,playback:[]};
  const played=[];
  const speech=await createSpeech({stateDir:dir,view:()=>view,now:()=>time,minIntervalMs:45000,
    synthesize:async text=>({text}),play:async audio=>{played.push(audio.text);},pause:async()=>{},trace:()=>{}});
  t.after(async()=>{await speech.close();await rm(dir,{recursive:true,force:true});});
  await speech.configure({enabled:true});

  view.playback=[{id:'a1',text:'普通建议。',at:time,expiresAt:time+90000,priority:0}];
  speech.tick();await speech.settle();
  assert.deepEqual(played,['普通建议。']);

  // 1s later the advice quiet window is still open, yet the praise must be spoken now.
  time+=1000;view.updatedAt=time;
  view.playback=[...view.playback,{id:'p1',text:'五杀！这波太漂亮了！',at:time,expiresAt:time+12000,priority:2,topic:'praise'}];
  speech.tick();await speech.settle();
  assert.deepEqual(played,['普通建议。','五杀！这波太漂亮了！']);

  // 10s after the praise, advice is still blocked (the praise quiet window is 15s)...
  time+=10_000;view.updatedAt=time;
  view.playback=[...view.playback,{id:'a2',text:'十秒后的战术建议。',at:time,expiresAt:time+90000,priority:0}];
  speech.tick();await speech.settle();
  assert.equal(played.length,2,'advice does not speak inside the 15s praise window');

  // ...but 16s after the praise it speaks again, instead of waiting a full 45s.
  time+=6_000;view.updatedAt=time;
  view.playback=[...view.playback,{id:'a3',text:'十六秒后的战术建议。',at:time,expiresAt:time+90000,priority:0}];
  speech.tick();await speech.settle();
  assert.equal(played.length,3,'tactical advice resumes after 15s, not 45s');
  assert.equal(played.at(-1),'十六秒后的战术建议。');
});

test('the live service uses the mentor the player actually picked',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'jinbao-praise-role-'));
  await mkdir(join(dir,'logs'));
  // The overlay service and the speech module share stateDir, so the chosen mentor is
  // read from the speech settings instead of being threaded through as a callback.
  await writeFile(join(dir,'speech-settings.json'),JSON.stringify({enabled:true,chat:true,role:'tiezhi',source:'official'}));
  const at=Date.now()-6_000;
  const rows=[
    {kind:'game_start',me:{champion:'安妮',riotId:ME}},
    {kind:'event',name:'Multikill',KillStreak:5,killer:ME},
  ].map((row,index)=>JSON.stringify({game:'lol',match:'m1',t:at+index*100,...row})).join('\n')+'\n';
  await writeFile(join(dir,'logs/live.jsonl'),rows);
  const service=await createOverlayService({stateDir:dir,pollMs:10,search:async()=>({results:[]})});
  t.after(async()=>{await service.close();await rm(dir,{recursive:true,force:true,maxRetries:3});});
  let praise=null;
  for(let i=0;i<200&&!praise;i++){
    await new Promise(resolve=>setTimeout(resolve,10));
    praise=service.view().playback.find(row=>row.topic==='praise')??null;
  }
  assert.ok(praise,'the service must surface the praise');
  assert.equal(praise.text,praiseText({streak:5,role:'tiezhi'}),'tone must follow the selected mentor');
  assert.notEqual(praise.text,praiseText({streak:5,role:'jinbao'}));
});
