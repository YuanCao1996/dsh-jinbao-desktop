import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,appendFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createOverlayService} from '../overlay-state.mjs';

// The 20 Hz card watcher decides most picks locally. These cover the other half: what
// the overlay does with the two frames it saves when it cannot decide, so a vision
// answer either settles the pick or leaves the question open — never guesses.

const waitFor=async(check,label)=>{for(let i=0;i<250;i++){if(await check())return;await new Promise(r=>setTimeout(r,20));}assert.fail('timed out: '+label);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

const OPTIONS=[{slot:0,name:'珠光护手'},{slot:1,name:'巨人杀手'},{slot:2,name:'法术强攻'}];
const FRAMES={baselineImage:join(tmpdir(),'jinbao-tie-break','baseline.png'),lastImage:join(tmpdir(),'jinbao-tie-break','last.png')};

// Only the "本局已选" section says what the match now assumes, so read that instead of
// the whole advice text (the offered cards are listed elsewhere on the page too).
const ownedText=view=>{
 const text=String(view().advice??''),at=text.indexOf('本局已选');
 return at<0?'':text.slice(at,at+80);
};

async function start({answer='2',withImageRoute=true}={}){
 const dir=await mkdtemp(join(tmpdir(),'jinbao-tiebreak-'));
 await mkdir(join(dir,'logs'));
 const log=join(dir,'logs/lol-tie.jsonl'),at=Date.now()-100;
 await writeFile(log,JSON.stringify({game:'lol',match:'one',kind:'game_start',mode:'KIWI',t:at,gameTime:180,
  me:{champion:'安妮',level:6,championAlias:'Annie',items:[]},allies:[],enemies:[]})+'\n');
 const calls=[];
 const overlay=await createOverlayService({stateDir:dir,pollMs:20,
  agentChat:async()=>{throw Object.assign(Error('no equipment model'),{status:503});},
  agentImage:withImageRoute?async request=>{calls.push(request);return answer;}:undefined,
  search:async()=>({results:[]})});
 return {dir,log,overlay,calls,at};
}
const offerLine=at=>JSON.stringify({game:'lol',match:'one',kind:'augment_offer',t:at+100,roll:1,options:OPTIONS})+'\n';
const ambiguousLine=at=>JSON.stringify({game:'lol',match:'one',kind:'augment_vision_ambiguous',t:at+200,roll:1,
 options:OPTIONS,reason:'panel-closed',frames:12,peak:41.5,...FRAMES})+'\n';

test('a saved frame pair lets the vision model settle an undecided pick',async()=>{
 const {dir,log,overlay,calls,at}=await start();
 try{
  await appendFile(log,offerLine(at));
  await waitFor(()=>overlay.view().advice.includes('海克斯推荐'),'offer rendered');
  assert.ok(!ownedText(()=>overlay.view()).includes('巨人杀手'),'nothing is owned before the pick');
  await appendFile(log,ambiguousLine(at));
  await waitFor(()=>ownedText(()=>overlay.view()).includes('巨人杀手'),'tiebreak pick applied');
  assert.equal(calls.length,1,'the model is asked exactly once');
  assert.deepEqual(calls[0].images.map(row=>row.mediaType),['image/png','image/png']);
  assert.deepEqual(calls[0].images.map(row=>row.path),[FRAMES.baselineImage,FRAMES.lastImage]);
 }finally{await overlay.close();await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});

test('an unsure answer never invents a pick',async()=>{
 const {dir,log,overlay,calls,at}=await start({answer:'看不清'});
 try{
  await appendFile(log,offerLine(at));
  await waitFor(()=>overlay.view().advice.includes('海克斯推荐'),'offer rendered');
  await appendFile(log,ambiguousLine(at));
  await sleep(400);
  assert.equal(calls.length,1,'the model still gets one look');
  assert.ok(!ownedText(()=>overlay.view()).includes('巨人杀手'),'an unparsed answer must not own a card');
  assert.ok(!ownedText(()=>overlay.view()).includes('珠光护手'),'and must not fall back to the first card');
 }finally{await overlay.close();await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});

test('without an image route the undecided panel stays a question',async()=>{
 const {dir,log,overlay,calls,at}=await start({withImageRoute:false});
 try{
  await appendFile(log,offerLine(at));
  await waitFor(()=>overlay.view().advice.includes('海克斯推荐'),'offer rendered');
  await appendFile(log,ambiguousLine(at));
  await sleep(400);
  assert.equal(calls.length,0);
  assert.ok(!ownedText(()=>overlay.view()).includes('巨人杀手'),'cloud/legacy routes must not own a card here');
 }finally{await overlay.close();await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});

test('the same frame pair is only sent to the model once',async()=>{
 const {dir,log,overlay,calls,at}=await start();
 try{
  await appendFile(log,offerLine(at));
  await waitFor(()=>overlay.view().advice.includes('海克斯推荐'),'offer rendered');
  await appendFile(log,ambiguousLine(at)+ambiguousLine(at));
  await waitFor(()=>ownedText(()=>overlay.view()).includes('巨人杀手'),'tiebreak pick applied');
  await sleep(300);
  assert.equal(calls.length,1,'a re-read log line must not re-ask the model');
 }finally{await overlay.close();await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});

test('a late timeout for an already decided round never asks the model again',async()=>{
 const {dir,log,overlay,calls,at}=await start();
 try{
  await appendFile(log,offerLine(at));
  await waitFor(()=>overlay.view().advice.includes('海克斯推荐'),'offer rendered');
  // The watcher decided locally and the pick is already recorded for this round.
  await appendFile(log,JSON.stringify({game:'lol',match:'one',kind:'augment_picked',t:at+150,roll:1,
   name:'巨人杀手',augment:'巨人杀手',who:'self',source:'vision-click',confidence:'high'})+ '\n');
  await waitFor(()=>ownedText(()=>overlay.view()).includes('巨人杀手'),'pick applied');
  // A watcher that outlived its decision reports a timeout later; it must be ignored.
  await appendFile(log,ambiguousLine(at+400));
  await sleep(400);
  assert.equal(calls.length,0,'no second opinion for a decided round');
  assert.equal(ownedText(()=>overlay.view()).includes('珠光护手'),false,'no other augment may be added');
 }finally{await overlay.close();await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});
