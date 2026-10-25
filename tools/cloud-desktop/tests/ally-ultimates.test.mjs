import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createAllyUltimateObserver} from '../../lol-companion/ally-ultimates.mjs';
import {createHudAssets} from '../../lol-companion/hud-assets.mjs';
import {createItemCatalogue,isCompletedItem} from '../../lol-companion/item-policy.mjs';
import {initialOverlayState,applyOverlayEvent,overlayView} from '../../dsh-onboarding/overlay-state.mjs';

const state=()=>({sideSource:'activePlayer.team',me:{championAlias:'Annie'},allies:[{champion:'金克丝',championAlias:'Jinx',dead:false},{champion:'卡特琳娜',championAlias:'Katarina',dead:true},{champion:'安妮',championAlias:'Annie',dead:false}],gameTime:100});
const frame=(at,ready=true,alias='Jinx')=>({available:true,foreground:true,capturedAt:at,allyHud:{key:'one',observations:[{alias,ready,portraitScore:.9,indicatorScore:.8}]}});

test('ally R requires two fresh observations, excludes self/enemy/dead, and deduplicates ready cycles',()=>{
 let now=1000;const events=[],observer=createAllyUltimateObserver(e=>events.push(e),{now:()=>now}),s=state();
 const observe=(ready=true,alias='Jinx')=>{now+=500;observer.observe(frame(now,ready,alias),s,'one');};
 observe();assert.equal(events.length,0);observe();assert.equal(events.at(-1).notify,true);observe();assert.equal(events.length,1);
 observe(false);observe(false);assert.equal(events.at(-1).ready,false);observe();observe();assert.equal(events.at(-1).notify,false);
 now+=30000;observe();observe();assert.equal(events.at(-1).notify,true);
 for(const alias of ['Annie','Enemy','Katarina']){observe(true,alias);observe(true,alias);}
 assert.equal(events.filter(e=>e.notify).length,2);
 s.allies[1].dead=false;observe(true,'Katarina');assert.equal(events.at(-1).championAlias,'Katarina');assert.equal(events.at(-1).notify,true);
 observer.reset();observe();assert.equal(events.filter(e=>e.championAlias==='Jinx'&&e.notify).length,2);
});

test('hidden, stale, mismatched and unrecognized frames cannot complete confirmation',()=>{
 let now=10000;const events=[],observer=createAllyUltimateObserver(e=>events.push(e),{now:()=>now}),s=state();
 const first=frame(now);observer.observe(first,s,'one');observer.observe(first,s,'one');assert.equal(events.length,0);
 observer.observe({...frame(now+1),foreground:false},s,'one');now+=500;observer.observe(frame(now),s,'one');assert.equal(events.length,0);
 now+=500;observer.observe(frame(now),s,'wrong');now+=500;observer.observe(frame(now),s,'one');assert.equal(events.length,0);
 observer.observe(frame(now-5000),s,'one');now+=500;observer.observe(frame(now),s,'one');assert.equal(events.length,0);
 now+=500;observer.observe({...frame(now),allyHud:{key:'one',observations:[]}},s,'one');now+=500;observer.observe(frame(now),s,'one');assert.equal(events.length,0);
 now+=500;observer.observe(frame(now),s,'one');assert.equal(events.length,1);
 observer.reset();s.sideSource='assumed-ORDER';now+=500;observer.observe(frame(now),s,'one');now+=500;observer.observe(frame(now),s,'one');assert.equal(events.length,1);
});

test('HUD asset generations discard old match portraits and retain only local current allies',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jinbao-hud-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 let release;const blocked=new Promise(r=>release=r),calls=[];
 const assets=createHudAssets({stateDir:dir,load:async(id,signal)=>{calls.push(id);assert.equal(signal.aborted,false);if(id===1)await blocked;return Buffer.from([137,80,78,71,13,10,26,10,id]);}});
 const request=(match,ids)=>({match,source:123,state:{sideSource:'activePlayer.team',me:{championAlias:'Self'},allies:ids.map(id=>({championAlias:'Hero'+id}))},champions:ids.map(id=>({id,alias:'Hero'+id}))});
 const old=assets.update(request('old',[1,2,3]));const oldKey=assets.key();assets.update(request('new',[4,5,6]));assert.notEqual(oldKey,assets.key());release();await old;
 for(let i=0;i<100;i++){const value=JSON.parse(await readFile(join(dir,'ally-hud-catalogue.json'),'utf8'));if(value.key===assets.key()&&value.portraits.length===3)break;await new Promise(r=>setTimeout(r,5));}
 const current=JSON.parse(await readFile(join(dir,'ally-hud-catalogue.json'),'utf8'));assert.deepEqual(current.portraits.map(p=>p.alias),['Hero4','Hero5','Hero6']);
 await assets.update(request('new',[4,5,6]));assert.equal(calls.length,6);await assets.close();
});

test('R reminders expire, clear when consumed, exclude dead teammates and reach battle playback/events',()=>{
 const s=initialOverlayState(),now=Date.now(),roster=state();
 applyOverlayEvent(s,{game:'lol',kind:'game_start',t:now,...roster},'one');
 const event={game:'lol',kind:'ally_ultimate',t:now+1,capturedAt:now,championAlias:'Jinx',source:'hud-indicator',ready:true,notify:true,gameTime:100};
 applyOverlayEvent(s,event,'one');let view=overlayView(s);assert.match(view.advice,/金克丝大招可用/);assert.equal(view.playback.at(-1).expiresAt,now+4000);assert.match(view.events,/金克丝/);
 applyOverlayEvent(s,{...event,t:now+2,capturedAt:now+1,ready:false,notify:false},'one');assert.doesNotMatch(overlayView(s).advice,/金克丝大招可用/);
 assert.equal(overlayView(s).revokedPlayback.length,1);
 applyOverlayEvent(s,{...event,t:now+3,championAlias:'Katarina'},'one');assert.doesNotMatch(overlayView(s).advice,/卡特琳娜大招可用/);
 applyOverlayEvent(s,{...event,t:now+4,capturedAt:now-10000},'one');assert.doesNotMatch(overlayView(s).advice,/金克丝大招可用/);
});

test('real flattened catalogue metadata distinguishes T1 components, completed specials, boots and Ornn edges',()=>{
 const rows=[{id:1026,name:'爆裂魔杖',inStore:true,price:850,icon:'AP_T1_Wand.png'},
 {id:1058,name:'无用大棒',inStore:true,price:1200,icon:'AP_T1_Rod.png'},
 {id:3031,name:'无尽之刃',inStore:true,price:3500,icon:'AD_T3_Infinity.png',into:[90001]},
 {id:90001,name:'升级装备',inStore:false,requiredAlly:'Ornn'},
 {id:223118,name:'残疫',inStore:true,price:2500},
 {id:9990,name:'新版成装',inStore:true,price:3100},
 {id:3006,name:'狂战士胫甲',inStore:true,price:1100,cats:['Boots'],icon:'Boots_T2.png'},
 {id:9991,name:'消耗品',inStore:true,price:2500,cats:['Consumable']}];
 const enrich=createItemCatalogue(rows);assert.deepEqual(rows.map(row=>isCompletedItem(enrich(row))),[false,false,true,false,true,true,true,false]);
});
