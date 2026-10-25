import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createGameMemory} from '../../dsh-coach-server/lib/game-memory.js';
import {createEventQuery} from '../event-query.mjs';

test('cloud query pages earlier purchases and nested chat events within the requested match',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jinbao-event-query-'));
 try{
  const memory=createGameMemory(dir),state={game:'lol',match:'one'};
  await memory.record(state,{kind:'purchase',gameTime:45,item:'遗失的章节'},'local-private-path');
  for(let i=0;i<50;i++)await memory.record(state,{kind:'state',state:{time:100+i,gold:300}},'fixture');
  await memory.record(state,{kind:'chat_events',gameTime:300,events:[{kind:'purchase',item:'残疫',champion:'安妮'}]},'fixture');
  await memory.record({game:'lol',match:'two'},{kind:'purchase',gameTime:1,item:'另一局秘密'},'fixture');
  const query=createEventQuery(memory);
  const first=await query({game:'lol',match:'one',args:{kind:'purchase',limit:1}});
  assert.match(JSON.stringify(first),/遗失的章节/);assert.equal(first.rows[0].time,'00:45');
  assert.equal(typeof first.next_cursor,'number');
  const next=await query({game:'lol',match:'one',args:{kind:'purchase',cursor:first.next_cursor,limit:1}});
  assert.match(JSON.stringify(next),/残疫/);assert.equal(next.rows[0].time,'05:00');
  assert.doesNotMatch(JSON.stringify([first,next]),/另一局秘密|local-private-path|fixture/);
  assert.ok(Buffer.byteLength(JSON.stringify(next))<14000);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('cloud event query rejects file/session overrides and invalid paging before reading',async()=>{
 const query=createEventQuery({query:async()=>assert.fail('Must not read')});
 for(const args of [{source:'../secret'},{game:'wzry'},{match:'other'},{limit:11},{cursor:-1},{kind:'../../'}])
  await assert.rejects(query({game:'lol',match:'one',args}));
});
test('sparse local state records are scanned in bounded chunks without returning the raw stream',async()=>{
 let reads=0;
 const query=createEventQuery({query:async request=>{
  reads++;if(reads<3)return{game:'lol',match:'one',rows:[],nextCursor:request.cursor+512*1024};
  return{game:'lol',match:'one',rows:[{event:{kind:'purchase',item:'残疫',gameTime:180}}],nextCursor:null};
 }});
 const result=await query({game:'lol',match:'one',args:{kind:'purchase'}});
 assert.equal(reads,3);assert.match(result.rows[0].details,/残疫/);
 let capped=0;const bounded=createEventQuery({query:async request=>{capped++;return{rows:[],nextCursor:request.cursor+512*1024};}});
 assert.equal((await bounded({game:'lol',match:'one'})).next_cursor,4*1024*1024);assert.equal(capped,8);
});
test('history retains candidate names, uncertainty and compact observed state',async()=>{
 const query=createEventQuery({query:async()=>({rows:[
  {event:{kind:'augment_offer',gameTime:180,options:[{name:'仆从大师'},'珠光护手']}},
  {event:{kind:'augment_picked',gameTime:185,augment:'仆从大师',source:'ocr-inferred',confidence:'low'}},
  {event:{kind:'state',state:{time:190,champion:'安妮',level:6,gold:900,items:[{name:'残疫',playerName:'private'}],playerName:'private'}}}
 ],nextCursor:null})});
 const result=await query({game:'lol',match:'one'});
 assert.deepEqual(JSON.parse(result.rows[0].details).candidates,['仆从大师','珠光护手']);
 assert.equal(JSON.parse(result.rows[1].details).selection_status,'unconfirmed');
 assert.equal(JSON.parse(result.rows[2].details).observedState.gold,900);
 assert.doesNotMatch(JSON.stringify(result),/playerName|private|ocr-inferred/);
});
