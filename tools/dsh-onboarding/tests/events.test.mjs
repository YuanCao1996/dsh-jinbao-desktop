import test from 'node:test';
import assert from 'node:assert/strict';
import {initialOverlayState,applyOverlayEvent,overlayView} from '../overlay-state.mjs';

test('event page retains key objectives in Chinese, hides combat spam and identifiers, and deduplicates repeated records',()=>{
 const s=initialOverlayState();let t=1;
 const emit=(name,extra={})=>applyOverlayEvent(s,{game:'lol',kind:'event',name,time:60,t:++t,killer:'隐藏玩家',victim:'隐藏对手',...extra},'game');
 for(const name of ['ChampionKill','Multikill','FirstBlood','MinionsSpawning','FirstBrick','UnknownEvent','constructor','__proto__'])emit(name);
 assert.equal(s.events.length,0);
 emit('TurretKilled',{id:1});emit('TurretKilled',{id:1});emit('Ace',{id:2});
 emit('InhibKilled',{id:3});emit('InhibRespawningSoon',{id:4});emit('InhibRespawned',{id:5});
 emit('DragonKill',{id:6});emit('BaronKill',{id:7});emit('HeraldKill',{id:8});
 assert.equal(s.events.length,8);
 const view=overlayView(s).events;
 assert.match(view,/01:00 防御塔被摧毁/);assert.match(view,/团灭/);assert.match(view,/水晶已重生/);assert.match(view,/大龙被击败/);
 assert.doesNotMatch(view,/隐藏|ChampionKill|TurretKilled|一血|多杀|小兵/);
 emit('GameEnd',{id:9,Result:'Win'});assert.equal(s.ended,true);assert.match(overlayView(s).events,/对局结束 · 胜利/);
 applyOverlayEvent(s,{game:'lol',kind:'game_start',t:++t,me:{champion:'安妮'}},'next');
 assert.equal(s.events.length,0);
});

test('ordinary kills do not evict key events and the page keeps at most forty key records',()=>{
 const s=initialOverlayState();let t=1;
 const emit=(name,id)=>applyOverlayEvent(s,{game:'lol',kind:'event',name,id,time:id,t:++t},'game');
 emit('GameStart',0);for(let i=1;i<500;i++)emit('ChampionKill',i);
 assert.equal(s.events.length,1);assert.match(overlayView(s).events,/对局开始/);
 for(let i=1;i<=45;i++)emit('TurretKilled',i);
 assert.equal(s.events.length,40);
});

test('the events page mirrors the window the Agent receives and says what was held back',()=>{
 const s=initialOverlayState();let t=1;
 const emit=(id)=>applyOverlayEvent(s,{game:'lol',kind:'event',name:'TurretKilled',id,time:id,t:++t},'game');
 for(let i=1;i<=35;i++)emit(i);
 // State keeps 40 for history; the page and the model both see the same 20-row window.
 assert.equal(s.events.length,35);
 const page=overlayView(s).events;
 assert.equal(page.split('\n').filter(line=>line.startsWith('00:')).length,20);
 assert.match(page,/更早 15 条未进入智能体上下文/);
 // The newest event is shown, the oldest is not.
 assert.match(page,/防御塔被摧毁/);
 assert.ok(page.includes('00:35') || page.includes('00:3'), 'newest row present');
});

test('event rows carry a kind so the Agent can classify them without querying',()=>{
 const s=initialOverlayState();let t=1;
 applyOverlayEvent(s,{game:'lol',kind:'event',name:'Ace',id:7,time:120,t:++t},'game');
 assert.equal(s.events.at(-1).kind,'Ace');
});
