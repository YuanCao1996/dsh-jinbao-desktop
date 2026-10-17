import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createChampionSelectionReader,projectChampionSelection} from '../../lol-companion/champ-select.mjs';
import {createOverlayRouter,createOverlayService} from '../overlay-state.mjs';
const champions=[{id:1,name:'安妮'},{id:2,name:'锐雯'},{id:3,name:'布隆'}];
const session={localPlayerCellId:1,myTeam:[{cellId:1,championId:1,puuid:'secret'},{cellId:2,championId:0,championPickIntent:2}],theirTeam:[{championId:0}],benchChampions:[{championId:3}]};
const pause=()=>new Promise(r=>setTimeout(r,10));
async function until(check){for(let i=0;i<200;i++){if(check())return;await pause();}throw Error('timed out');}

test('selection projects visible picks, intents and bench without player identifiers; catalog is cached',async()=>{
 const facts=projectChampionSelection(session,champions);
 assert.deepEqual(facts.allies.map(r=>r.champion),['安妮','锐雯']);assert.equal(facts.enemies.length,0);assert.equal(facts.bench[0].champion,'布隆');
 assert.doesNotMatch(JSON.stringify(facts),/secret|puuid|cellId/);
 let reads=0;const reader=createChampionSelectionReader(async(_c,path)=>({status:200,data:path.endsWith('session')?session:(reads++,champions)}));
 await reader({port:1});await reader({port:1});assert.equal(reads,1);
 await reader({port:2});assert.equal(reads,2);
});

test('selection is active before any game clock, cancellation clears it and live match replaces it',()=>{
 const r=createOverlayRouter();
 r.apply({game:'lol',kind:'champ_select',match:'select-a',t:1,...projectChampionSelection(session,champions)},'selection');
 assert.equal(r.state().phase,'ChampSelect');assert.equal(r.state().gameSeconds,null);assert.equal(r.state().me.champion,'安妮');
 r.apply({game:'lol',kind:'champ_select_end',match:'select-a',cancelled:true,t:2},'selection');
 assert.equal(r.state().bench.length,0);assert.equal(r.state().me.champion,undefined);
 r.apply({game:'lol',kind:'champ_select',match:'select-b',t:3,...projectChampionSelection(session,champions)},'selection2');
 r.apply({game:'lol',kind:'game_start',t:4,me:{champion:'锐雯'},gameTime:1},'live');
 assert.equal(r.state().me.champion,'锐雯');assert.equal(r.state().bench.length,0);assert.equal(r.state().gameSeconds,1);
});

test('pregame hero rates work without own pick, update the bench and do not call models or repeat cached searches',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jinbao-selection-'));await mkdir(join(dir,'logs'));
 const file=join(dir,'logs/select.jsonl');let at=Date.now();const calls=[];
 const emit=facts=>JSON.stringify({game:'lol',kind:'champ_select',match:'select-a',t:++at,me:{},allies:[],enemies:[],...facts})+'\n';
 await writeFile(file,emit({bench:[{champion:'安妮'},{champion:'锐雯'}]}));
 const service=await createOverlayService({stateDir:dir,pollMs:10,complete:async()=>{throw Error('selection must not call a model');},search:async q=>{
  calls.push(q);assert.equal(q.dataset,'aram-ranking');
  return {results:[{data:{name:q.query,winRate:q.query==='安妮'?55:51,tier:q.query==='安妮'?0:1}}]};
 }});t.after(service.close);
 await until(()=>service.view().playerRows.length===2&&service.view().playerRows.every(r=>r.winRate!==null));
 assert.deepEqual(service.view().playerRows.map(r=>r.tierText),['T0','T1']);assert.equal(service.view().gameTime,'等待对局');
 await appendFile(file,emit({me:{champion:'锐雯'},allies:[{champion:'锐雯'}],bench:[{champion:'布隆'}]}));
 await until(()=>service.view().playerRows.some(r=>r.champion==='布隆'&&r.winRate!==null));
 assert.doesNotMatch(service.view().players,/安妮/);assert.equal(calls.filter(q=>q.query==='锐雯').length,1);assert.equal(calls.length,3);
});
