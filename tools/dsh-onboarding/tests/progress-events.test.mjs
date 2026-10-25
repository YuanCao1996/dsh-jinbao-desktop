import test from 'node:test';
import assert from 'node:assert/strict';
import {initialOverlayState,applyOverlayEvent,overlayView} from '../overlay-state.mjs';
import {createChatObserver,createChatCatalogReader} from '../../lol-companion/chat-observer.mjs';

test('historical purchase and augment formats remain visible, retain match time and never assign teammates or low confidence picks to self',()=>{
 const s=initialOverlayState();let at=1;
 const emit=e=>applyOverlayEvent(s,{game:'lol',t:++at,...e},'game');
 emit({kind:'game_start',me:{champion:'安妮'}});
 emit({kind:'chat_events',events:[{kind:'purchase',time:'03:56',item:'残疫',itemId:223118},{kind:'purchase',time:'04:00',itemUnresolved:true},{kind:'kill',text:'隐藏玩家'}]});
 emit({kind:'augment_picked',name:'不动如山',source:'ocr-inferred',confidence:'low',roll:1});
 emit({kind:'augment_mutate',augment:'珠光护手',champion:'锐雯',who:'ally',confidence:'high',time:'13:06'});
 emit({kind:'augment_mutate',augment:'双刀流',champion:null,who:'unknown',confidence:'high'});
 assert.deepEqual(s.ownedAugments,[]);
 emit({kind:'augment_mutate',augment:'终极唤醒',champion:'安妮',who:'self',confidence:'high',time:'14:02'});
 assert.deepEqual(s.ownedAugments,['终极唤醒']);
 const events=overlayView(s).events;
 assert.match(events,/03:56 .*购买装备：残疫/);assert.doesNotMatch(events,/装备名称未识别/);
 assert.match(events,/疑似海克斯选择.*不动如山/);assert.match(events,/13:06 海克斯选择：锐雯 · 珠光护手/);
 assert.match(events,/归属未确认 · 双刀流/);assert.doesNotMatch(events,/隐藏玩家|ocr-inferred|source/);
});

test('inventory differences record item updates rather than fabricate purchases; initial snapshots, slot rearrangements and repeat states stay quiet',()=>{
 const s=initialOverlayState();let at=1;
 const emit=(items,kind='state')=>applyOverlayEvent(s,{game:'lol',kind,t:++at,me:{champion:'安妮',items},state:{time:20}},'game');
 emit([{id:1,name:'长剑'}],'game_start');assert.equal(s.events.length,0);
 emit([{id:1,name:'长剑'},{id:2,name:'残疫'}]);assert.equal(s.events.length,1);
 emit([{id:2,name:'残疫'},{id:1,name:'长剑'}]);assert.equal(s.events.length,1);
 emit([{id:2,name:'残疫'},{id:1,name:'长剑',count:2}]);assert.equal(s.events.length,1,'component count changes are not shown');
 assert.match(overlayView(s).events,/装备更新：安妮.*新增 残疫/);assert.doesNotMatch(overlayView(s).events,/购买装备/);
});

test('current OCR reuses the historical parser, deduplicates purchases, resolves explicit augment owner and emits no raw player text',()=>{
 const events=[];const observer=createChatObserver(['珠光护手'],event=>events.push(event));
 observer.setCatalog({champions:[{id:1,name:'安妮',alias:'Annie'},{id:2,name:'锐雯',alias:'Riven'}],items:[{id:223118,name:'残疫'}]});
 const state={gameTime:240,me:{champion:'安妮',championAlias:'Annie'},allies:[{champion:'锐雯',championAlias:'Riven'}],enemies:[]};
 const frame={available:true,foreground:true,width:1920,height:1080,lines:[
  {text:'03:56 隐藏玩家(安妮)购买了残疫',box:[[60,700],[700,700],[700,720],[60,720]]},
  {text:'04:00 隐藏玩家(锐雯):安妮已选择了珠光护手',box:[[60,740],[800,740],[800,760],[60,760]]},
 ]};
 observer.observe(frame,state);observer.observe(frame,state);
 assert.equal(events.length,2);assert.equal(events[0].events[0].item,'残疫');
 assert.equal(events[1].who,'self');assert.equal(events[1].champion,'安妮');
 assert.doesNotMatch(JSON.stringify(events),/隐藏玩家|text|display/);
 observer.reset();observer.observe({...frame,foreground:false},state);assert.equal(events.length,2);
});

test('native chat catalogs come from local client data and cache successful reads',async()=>{
 let calls=0;const read=createChatCatalogReader(async()=>{calls++;return {status:200,data:[{id:1,name:'安妮'}]};});
 const accepted=[];await read({port:1},c=>accepted.push(c));await read({port:1},c=>accepted.push(c));
 assert.equal(calls,2);assert.equal(accepted.length,1);
});
