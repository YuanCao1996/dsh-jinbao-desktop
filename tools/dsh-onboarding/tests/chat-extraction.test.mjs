import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatObserver} from '../../lol-companion/chat-observer.mjs';

// A tiny catalog with the real overlap that produced duplicates in live matches:
// 虹吸 is a substring of 灵魂虹吸, and 棱彩阶 of 质变：棱彩阶.
const NAMES=['虹吸','灵魂虹吸','棱彩阶','质变：棱彩阶','大力','海洋龙魂'];

function harness(){
  const events=[];
  const observer=createChatObserver(NAMES,e=>events.push(e));
  // Champion names only resolve when the player is on the roster snapshot, exactly like
  // the live path, so both teammates are listed here.
  const state={gameTime:300,me:{champion:'安妮',championAlias:'Annie'},
    allies:[{champion:'锐雯',championAlias:'Riven'},{champion:'劫',championAlias:'Zed'}],enemies:[]};
  const frame=(lines)=>observer.observe({available:true,foreground:true,width:1200,height:600,
    lines:lines.map((text,i)=>({text,box:[10,600+i*20,600,18]}))},state);
  const augmentEvents=()=>events.flatMap(e=>e.kind==='augment_mutate'?[e]:[]);
  const purchaseEvents=()=>events.flatMap(e=>e.kind==='chat_events'?(e.events??[]).filter(x=>x.kind==='purchase'):[]);
  return {observer,events,frame,augmentEvents,purchaseEvents};
}

test('an augment whose name contains another augment name emits one event, not two',()=>{
  const h=harness();
  h.frame(['某人（锐雯）已经质变了灵魂虹吸']);
  const rows=h.augmentEvents();
  assert.equal(rows.length,1,'one announcement must produce one event');
  assert.equal(rows[0].augment,'灵魂虹吸','the longest catalog name wins');
});

test('the same announcement re-read with a missing in-game time is reported once',async()=>{
  const h=harness();
  h.frame(['某人（锐雯）已经质变了大力']);
  h.frame(['某人（锐雯）已经质变了大力']);
  assert.equal(h.augmentEvents().length,1);
});

test('a different champion picking the same augment still produces its own event',()=>{
  const h=harness();
  h.frame(['甲（锐雯）已经质变了大力']);
  h.frame(['乙（劫）已经质变了大力']);
  const rows=h.augmentEvents();
  assert.equal(rows.length,2);
  assert.deepEqual(rows.map(r=>r.champion).sort(),['劫','锐雯']);
});

test('a purchase keeps the raw item text so an unresolved name can be diagnosed',()=>{
  const h=harness();
  h.frame(['某人（锐雯）购买了某件不认识的东西']);
  const rows=h.purchaseEvents();
  assert.equal(rows.length,1);
  assert.equal(rows[0].itemUnresolved,true);
  assert.ok(rows[0].itemRaw,'the raw OCR text must survive for diagnostics');
});
