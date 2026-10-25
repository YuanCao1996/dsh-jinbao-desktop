import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,appendFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createOverlayService} from '../../dsh-onboarding/overlay-state.mjs';
import {createGameMemory} from '../../dsh-coach-server/lib/game-memory.js';
import {createCloudCoach} from '../auto-coach.mjs';
const waitFor=async check=>{for(let i=0;i<100;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail('Overlay update timed out');};

test('cloud advice log reaches battle page and playback; the next match clears it',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jinbao-cloud-advice-'));let overlay,coach;
 try{
  await mkdir(join(dir,'logs'));const file=join(dir,'logs/lol-fixture.jsonl'),at=Date.now()-100;
  await writeFile(file,JSON.stringify({game:'lol',match:'one',kind:'game_start',mode:'KIWI',t:at,gameTime:180,me:{champion:'安妮',level:6,items:[]}})+'\n');
  overlay=await createOverlayService({stateDir:dir,pollMs:20,agentChat:async()=>{throw Error('No equipment model in this test');},search:async()=>({results:[]})});
  const memory=createGameMemory(dir),answer='安妮有大招时，等队友控制命中后再接提伯斯。';
  coach=createCloudCoach({stateDir:dir,view:overlay.view,getContext:(game,match)=>memory.currentFacts(game,match),agent:{ask:async()=>answer}});
  await coach.tick();await waitFor(()=>overlay.view().advice.includes(answer));
  const saved=JSON.parse((await readFile(join(dir,'logs/coach_broadcasts.jsonl'),'utf8')).trim());
  assert.equal(saved.match,'one');assert.equal(saved.kind,'cloud-advice');assert.equal(saved.broadcast,answer);
  const page=await memory.query({game:'lol',match:'one',kind:'cloud-advice'});assert.equal(page.rows[0].event.broadcast,answer);
  await waitFor(async()=>{try{return JSON.parse(await readFile(join(dir,'overlay-state.json'),'utf8')).advice.includes(answer);}catch{return false;}});
  await appendFile(file,JSON.stringify({game:'lol',match:'two',kind:'game_start',mode:'KIWI',t:Date.now(),gameTime:1,me:{champion:'锐雯',level:3,items:[]}})+'\n');
  await waitFor(()=>overlay.view().match==='two');assert.ok(!overlay.view().advice.includes(answer));
 }finally{coach?.close();await overlay?.close();await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});
