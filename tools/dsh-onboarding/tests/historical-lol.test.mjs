import test from 'node:test';
import assert from 'node:assert/strict';
import {createOverlayRouter,overlayView} from '../overlay-state.mjs';
import {createOverlayService} from '../overlay-state.mjs';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createCloudCoach} from '../../cloud-desktop/auto-coach.mjs';

test('positive live clock leaves Loading and does not repeatedly dispatch a mismatched loading task',async()=>{
 const router=createOverlayRouter(),emit=e=>router.apply({game:'lol',...e},'late-loading');let now=1000;const entries=[];
 emit({kind:'load',t:now,me:{champion:'安妮'},allies:[],enemies:[]});assert.equal(router.state().phase,'Loading');
 const coach=createCloudCoach({view:()=>({...overlayView(router.state()),updatedAt:router.state().at}),getContext:async()=>({current:router.state()}),now:()=>now,agent:{ask:async()=> '【回放传输响应】'},publish:async e=>entries.push(e)});
 await coach.tick();assert.equal(entries.at(-1).key,'loading');
 now=2000;emit({kind:'state',t:now,state:{time:20,level:3,items:[]}});assert.equal(router.state().phase,'InProgress');
 await coach.tick();assert.equal(entries.at(-1).key,'opening');
 for(let i=0;i<8;i++){now+=1000;emit({kind:'state',t:now,state:{time:21+i,level:3,items:[]}});await coach.tick();}
 assert.equal(entries.length,2);coach.close();
});

test('known roster win rates load before the local hero is resolved, without querying another hero augments',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jinbao-roster-first-'));await mkdir(join(dir,'logs'));const calls=[];
 const allies=Array.from({length:5},(_,i)=>({champion:'友'+i})),enemies=Array.from({length:5},(_,i)=>({champion:'敌'+i}));
 await writeFile(join(dir,'logs/lol-history.jsonl'),JSON.stringify({game:'lol',kind:'state',t:Date.now(),state:{time:0,allyPlayers:allies,enemyPlayers:enemies}})+'\n');
 const service=await createOverlayService({stateDir:dir,pollMs:10,search:async q=>{calls.push(q);return{results:[{data:{name:q.query,title:q.query,winRate:51,tier:1}}]};}});
 t.after(async()=>{await service.close();await rm(dir,{recursive:true,force:true});});
 for(let i=0;i<250&&service.view().playerRows.filter(r=>r.winRate!==null).length!==10;i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(service.view().playerRows.filter(r=>r.winRate!==null).length,10);assert.equal(calls.some(q=>q.filter?._type==='augments'),false);assert.match(service.view().augments,/等待英雄/);
});

test('historical loading and nested inventory records populate the same observed roster and equipment pages',()=>{
 const router=createOverlayRouter(),me={champion:'安妮',championId:1},allies=['布隆','金克丝','娜美','奥恩'].map(champion=>({champion})),enemies=['锐雯','洛','茂凯','卡特琳娜','科加斯'].map(champion=>({champion,items:[]}));
 router.apply({game:'lol',kind:'phase',t:1000,phase:'InProgress'},'old');
 router.apply({game:'lol',kind:'load',t:1001,me,allies,enemies},'old');
 router.apply({game:'lol',kind:'state',t:1002,state:{time:20,level:3,items:[{id:1036,name:'长剑'}],allyPlayers:allies,enemyPlayers:enemies}},'old');
 assert.equal(router.state().me.champion,'安妮');assert.equal(router.state().allies.length,5);assert.equal(router.state().enemies.length,5);assert.equal(router.state().phase,'InProgress');
 enemies[0]={...enemies[0],items:[{id:3031,name:'无尽之刃'}]};
 router.apply({game:'lol',kind:'state',t:1003,state:{time:21,allyPlayers:allies,enemyPlayers:enemies}},'old');
 assert.deepEqual(router.state().completedEquipmentEvents[0].items,['无尽之刃']);assert.match(overlayView(router.state()).events,/锐雯.*无尽之刃/);assert.doesNotMatch(overlayView(router.state()).equipment,/长剑/);
});

test('a partial modern roster already containing self is not inflated into five players',()=>{
 const router=createOverlayRouter(),me={champion:'安妮',championAlias:'Annie'},allies=[me,{champion:'布隆'},{champion:'金克丝'},{champion:'娜美'}];
 router.apply({game:'lol',kind:'game_start',t:1000,me,allies,enemies:[]},'partial');
 assert.equal(router.state().allies.length,4);assert.equal(router.state().allies.filter(p=>p.champion==='安妮').length,1);
});

test('late first game-start metadata keeps already observed choices; a subsequent actual start isolates the next match',()=>{
 const router=createOverlayRouter(),emit=e=>router.apply({game:'lol',...e},'historical');
 emit({kind:'state',t:1000,me:{champion:'安妮'},state:{time:5}});const match=router.state().match;
 emit({kind:'augment_offer',t:1001,roll:1,options:['甲','乙','丙']});emit({kind:'augment_picked',t:1002,who:'self',name:'甲',confidence:'high'});
 emit({kind:'game_start',t:1003,me:{champion:'安妮'}});
 assert.equal(router.state().match,match);assert.deepEqual(router.state().ownedAugments,['甲']);assert.equal(router.state().offers.length,3);assert.equal(router.state().gameSeconds,5);
 emit({kind:'event',t:2000,name:'GameEnd',time:900});emit({kind:'game_start',t:3000,gameTime:0,me:{champion:'金克丝'}});
 assert.notEqual(router.state().match,match);assert.deepEqual(router.state().ownedAugments,[]);assert.equal(router.state().me.champion,'金克丝');
});

test('duplicated pre-clock start metadata in historical logs does not invent three matches',()=>{
 const router=createOverlayRouter(),emit=e=>router.apply({game:'lol',...e},'duplicate-start');
 emit({kind:'phase',t:1000,phase:'InProgress'});emit({kind:'game_start',t:1001,me:{champion:'艾希'}});const match=router.state().match;
 emit({kind:'augment_picked',t:1002,who:'self',name:'强化甲',confidence:'high'});
 emit({kind:'game_start',t:17000,me:{champion:'艾希'}});emit({kind:'game_start',t:17000,me:{champion:'艾希'}});
 assert.equal(router.state().match,match);assert.deepEqual(router.state().ownedAugments,['强化甲']);
 emit({kind:'state',t:18000,state:{time:15}});emit({kind:'event',t:19000,name:'GameEnd',time:900});emit({kind:'game_start',t:20000,me:{champion:'艾希'}});
 assert.notEqual(router.state().match,match);assert.deepEqual(router.state().ownedAugments,[]);
});

test('an early clock rollback inside one historical file remains untrusted until two progressing observations',()=>{
 const router=createOverlayRouter();router.apply({game:'lol',kind:'game_start',t:1,gameTime:500,me:{champion:'安妮'}},'live');const match=router.state().match;
 router.apply({game:'lol',kind:'state',t:2,state:{time:0}},'live');assert.equal(router.state().match,match);
 router.apply({game:'lol',kind:'state',t:3,state:{time:1}},'live');assert.notEqual(router.state().match,match);assert.equal(router.state().gameSeconds,1);
});
