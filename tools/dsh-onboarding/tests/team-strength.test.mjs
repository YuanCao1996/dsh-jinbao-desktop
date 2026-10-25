import test from 'node:test';import assert from 'node:assert/strict';
import {teamStrength,liveTeamEstimate} from '../team-strength.mjs';
import {initialOverlayState,applyOverlayEvent,overlayView} from '../overlay-state.mjs';
test('tier weights affect mixed-strength team samples, preserve bounds and exclude bench',()=>{
 const rows=[{side:'友',winRate:60,tierText:'T0'},...Array.from({length:4},()=>({side:'友',winRate:40,tierText:'T4'})),{side:'备选',winRate:100,tierText:'T0'}];
 const value=teamStrength(rows,'友').value;assert.ok(Math.abs(value-45.4545454545)<1e-8);assert.notEqual(value,44);
 assert.equal(teamStrength(rows.map(r=>({...r,winRate:100})),'友').value,100);
 assert.equal(teamStrength(rows.map(r=>({...r,winRate:0})),'友').value,0);
 assert.equal(teamStrength(rows.map((r,i)=>i===0?{...r,tierText:'暂无'}:r),'友').value,null);
 assert.equal(teamStrength(rows.map((r,i)=>i===0?{...r,winRate:null}:r),'友').known,4);
 assert.equal(teamStrength(rows.slice(1),'友').value,null);
});
test('live estimate responds to score and time, is symmetric and keeps missing observations unknown',()=>{
 const rows=['友','敌'].flatMap(side=>Array.from({length:5},()=>({side,winRate:50,tierText:'T2'})));
 const estimate=(seconds,allyKills,enemyKills)=>liveTeamEstimate(rows,{seconds,allyKills,enemyKills});
 assert.equal(estimate(60,0,0).ally,50);
 assert.ok(estimate(600,15,10).ally>50);
 assert.ok(estimate(1200,15,10).ally>estimate(600,15,10).ally);
 assert.equal(estimate(600,15,10).ally,estimate(600,10,15).enemy);
 assert.equal(estimate(600,15,10).ally+estimate(600,15,10).enemy,100);
 assert.equal(estimate(null,0,0),null);assert.equal(estimate(100,undefined,2),null);
 assert.equal(liveTeamEstimate(rows,{seconds:100,allyKills:1,enemyKills:2,sideSource:'assumed-ORDER'}),null);
 assert.equal(liveTeamEstimate([],{seconds:600,allyKills:0,enemyKills:0}).heroPriorKnown,false);
 assert.ok(estimate(2000,1000,0).ally<=95);
});
test('score and clock updates change the live page but never rewrite hero sample rates',()=>{
 const state=initialOverlayState();applyOverlayEvent(state,{game:'lol',kind:'game_start',t:1,me:{champion:'安妮'},enemies:[{champion:'锐雯'}]},'match');
 const knowledge={rows:[{_viewKind:'hero',name:'安妮',winRate:55,tier:'T1'},{_viewKind:'hero',name:'锐雯',winRate:50,tier:'T2'}]};
 applyOverlayEvent(state,{game:'lol',kind:'state',t:2,state:{time:180,teamKills:6,enemyKills:2}},'match');
 const first=overlayView(state,knowledge);
 applyOverlayEvent(state,{game:'lol',kind:'state',t:3,state:{time:900,teamKills:6,enemyKills:8}},'match');
 const next=overlayView(state,knowledge);
 assert.match(first.teamWinRates,/局势估计/);assert.notEqual(first.teamWinRates,next.teamWinRates);
 assert.deepEqual(first.playerRows.map(r=>r.winRate),next.playerRows.map(r=>r.winRate));
 assert.match(next.teamWinRatesNote,/未经对局结果校准/);
});
