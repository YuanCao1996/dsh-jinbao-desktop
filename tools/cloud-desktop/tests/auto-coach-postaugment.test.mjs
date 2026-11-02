import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,appendFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createOverlayService} from '../../dsh-onboarding/overlay-state.mjs';
import {createGameMemory} from '../../dsh-coach-server/lib/game-memory.js';
import {createCloudCoach} from '../auto-coach.mjs';

const waitFor=async(check,label)=>{for(let i=0;i<250;i++){if(await check())return;await new Promise(r=>setTimeout(r,20));}assert.fail('timed out: '+label);};

test('confirming an augment produces playstyle advice on the battle page',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jinbao-postaugment-'));let overlay,coach;
 try{
  await mkdir(join(dir,'logs'));
  const file=join(dir,'logs/lol-fixture.jsonl'),at=Date.now()-100;
  await writeFile(file,JSON.stringify({game:'lol',match:'one',kind:'game_start',mode:'KIWI',t:at,gameTime:180,
    me:{champion:'安妮',level:6,championAlias:'Annie',items:[]},allies:[],enemies:[]})+'\n');
  overlay=await createOverlayService({stateDir:dir,pollMs:20,agentChat:async()=>{throw Error('no equipment model');},search:async()=>({results:[]})});
  const memory=createGameMemory(dir);
  const answer='强化效果：珠光护手让技能可以暴击；打法：等队友开团后接提伯斯；下一件成装：下次可购买时做灭世者的死亡之帽。';
  const stages=[];
  coach=createCloudCoach({stateDir:dir,view:overlay.view,getContext:(game,match)=>memory.currentFacts(game,match),
    trace:e=>{if(e.stage)stages.push(e.stage);},agent:{ask:async()=>answer}});

  // The player confirms an augment; nothing else competes for this turn.
  await appendFile(file,JSON.stringify({game:'lol',match:'one',kind:'augment_mutate',t:at+200,gameTime:200,
    augment:'珠光护手',champion:'安妮',who:'self',source:'log-confirmed',confidence:'high'})+'\n');
  await waitFor(()=>overlay.view().advice.includes('本局已选海克斯')&&overlay.view().advice.includes('珠光护手'),'owned applied');

  // Tick until the advice lands. A fixed 5x150ms window was too tight: under a
  // full-suite run this turn takes ~955ms, so the retries ran out and the test
  // failed on CPU contention rather than on behaviour.
  await waitFor(async()=>{await coach.tick();return overlay.view().advice.includes('强化效果');},'postAugment advice');
  const advice=overlay.view().advice;
  assert.ok(stages.includes('postAugment'),'postAugment stage must run after the confirmation, saw: '+JSON.stringify(stages));
  assert.ok(advice.includes('强化效果'),'the confirmed augment must produce playstyle advice on the battle page:\n'+advice);
 }finally{coach?.close();await overlay?.close();await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});
