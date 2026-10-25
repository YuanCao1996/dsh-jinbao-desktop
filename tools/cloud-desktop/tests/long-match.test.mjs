import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createGameMemory} from '../../dsh-coach-server/lib/game-memory.js';
import {cloudContext} from '../cloud-agent.mjs';

test('long local chat never erases current hero facts or revision sent to cloud',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jinbao-long-cloud-'));
 try{
  const memory=createGameMemory(dir);
  await memory.snapshot({game:'lol',match:'one',at:123456,phase:'ChampSelect',me:{champion:'安妮',level:6},bench:[{champion:'锐雯'}],
   events:Array.from({length:100},(_,i)=>({time:String(i),text:'装备变化'.repeat(70)})),
   chat:Array.from({length:100},()=>({text:'历史聊天'.repeat(400)}))});
  const result=cloudContext(await memory.currentFacts('lol','one'),'lol','one');
  assert.equal(result.current_match_state.revision,123456);
  assert.equal(result.current_match_state.me.champion,'安妮');
  assert.equal(result.current_match_state.bench[0].champion,'锐雯');
  assert.equal(result.events.length,20);
  assert.ok(Buffer.byteLength(JSON.stringify(result))<24000);
  assert.ok(!JSON.stringify(result).includes('历史聊天'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
