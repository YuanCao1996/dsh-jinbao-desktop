import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initialOverlayState,applyOverlayEvent,createOverlayService} from '../overlay-state.mjs';
import {augmentConfirmation,augmentConfirmationId} from '../augment-confirmation.mjs';
const ranks=[{_type:'augments',champion:'安妮',name:'乙',rank:1},{_type:'augments',champion:'安妮',name:'甲',rank:3}];

test('late team confirmation writes its original round once after a newer panel opens',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'team-late-round-'));let service;
 t.after(async()=>{await service?.close();await rm(dir,{recursive:true,force:true,maxRetries:3});});
 await mkdir(join(dir,'logs'));const now=Date.now();
 const rows=[{kind:'game_start',me:{champion:'安妮'},t:now-180000},{kind:'augment_offer',roll:1,options:['甲','乙','丙'],t:now-179000},
  {kind:'augment_offer_closed',roll:1,t:now-178000},{kind:'augment_picked',roll:1,who:'self',augment:'甲',source:'countdown-default-confirmed',t:now-177000},
  {kind:'augment_offer',roll:2,options:['丁','戊','己'],t:now-100}].map(row=>({game:'lol',match:'one',...row}));
 await writeFile(join(dir,'logs/live.jsonl'),rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
 service=await createOverlayService({stateDir:dir});await service.refresh();
 let facts=await service.getTeamFacts();const round=facts.augmentRounds.find(row=>row.id===1),id=augmentConfirmationId(facts,round);
 await service.confirmTeamSelection({id,name:'乙',historical:true});await service.confirmTeamSelection({id,name:'乙',historical:true});
 facts=await service.getTeamFacts();assert.ok(facts.ownedAugments.includes('乙'));assert.equal(facts.ownedAugments.includes('甲'),false);assert.equal(facts.augmentRounds.find(row=>row.id===2).closed,false);
 const events=(await readFile(join(dir,'logs/lol-user-confirmations.jsonl'),'utf8')).trim().split('\n').map(row=>JSON.parse(row));
 assert.equal(events.length,1);assert.equal(events[0].roll,1);assert.equal(events[0].source,'team-user-confirmed');
});
test('confirmation appears only after closed-panel grace, sorts current choices by hero rank, and disappears after reliable confirmation',()=>{
 const s=initialOverlayState();let at=Date.now()-6000;
 const emit=e=>applyOverlayEvent(s,{game:'lol',match:'one',t:++at,...e},'one');
 emit({kind:'game_start',me:{champion:'安妮'}});emit({kind:'augment_offer',roll:1,options:['甲','乙','丙']});
 assert.equal(augmentConfirmation(s,ranks,at+4000),null);
 emit({kind:'augment_offer_closed',roll:1});assert.equal(augmentConfirmation(s,ranks,at+1000),null);
 const prompt=augmentConfirmation(s,ranks,at+4000);assert.deepEqual(prompt.options.map(o=>o.name),['乙','甲','丙']);
 emit({kind:'augment_mutate',who:'enemy',augment:'乙'});assert.ok(augmentConfirmation(s,ranks,at+4000));
 const copy=structuredClone(s);applyOverlayEvent(copy,{game:'lol',match:'one',kind:'augment_confirmation_dismissed',roll:1,t:at+1},'one');assert.equal(augmentConfirmation(copy,ranks,at+4000),null);assert.deepEqual(copy.ownedAugments,[]);
 emit({kind:'augment_picked',who:'self',augment:'甲',confidence:'high',roll:1});assert.equal(augmentConfirmation(s,ranks,at+4000),null);
});
test('one-click confirmation records actual choice, rejects stale IDs, persists replay, and dismissal does not invent ownership',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jinbao-confirm-'));await mkdir(join(dir,'logs'));const at=Date.now()-5000;
 const logs=[{kind:'game_start',me:{champion:'安妮'}},{kind:'augment_offer',roll:1,options:['甲','乙','丙']},{kind:'augment_offer_closed',roll:1}];
 await writeFile(join(dir,'logs/live.jsonl'),logs.map((e,i)=>JSON.stringify({game:'lol',match:'one',t:at+i,...e})).join('\n')+'\n');
 const open=()=>createOverlayService({stateDir:dir,pollMs:10,search:async()=>({results:ranks.map(data=>({data}))})});
 let service=await open();t.after(()=>service.close());
 for(let i=0;i<100&&!service.view().augments.includes('#1');i++)await new Promise(r=>setTimeout(r,10));
 let prompt=service.view().confirmation;assert.equal(prompt.options[0].name,'乙');
 await assert.rejects(service.confirm({id:'old',name:'乙'}),e=>e.status===409);
 await service.confirm({id:prompt.id,name:'甲'});assert.equal(service.view().confirmation,null);assert.match(service.view().augments,/本局已选\n甲/);
 await assert.rejects(service.confirm({id:prompt.id,name:'乙'}),e=>e.status===409);
 await service.close();service=await open();assert.match(service.view().augments,/本局已选\n甲/);assert.equal(service.view().confirmation,null);
});

test('countdown default accepts only current first choice and logs its real source',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jinbao-default-'));await mkdir(join(dir,'logs'));const at=Date.now()-5000;
 await writeFile(join(dir,'logs/live.jsonl'),[{kind:'game_start',me:{champion:'安妮'}},{kind:'augment_offer',roll:1,options:['甲','乙','丙']},{kind:'augment_offer_closed',roll:1}].map((e,i)=>JSON.stringify({game:'lol',match:'one',t:at+i,...e})).join('\n')+'\n');
 const service=await createOverlayService({stateDir:dir,pollMs:10,search:async()=>({results:ranks.map(data=>({data}))})});t.after(()=>service.close());
 for(let i=0;i<100&&!service.view().augments.includes('#1');i++)await new Promise(r=>setTimeout(r,10));
 const prompt=service.view().confirmation;
 await assert.rejects(service.confirm({id:prompt.id,name:'甲',timeoutDefault:true}),e=>e.status===409);
 await service.confirm({id:prompt.id,name:'乙',timeoutDefault:true});
 assert.equal(service.view().confirmation,null);
 const event=JSON.parse((await readFile(join(dir,'logs/lol-user-confirmations.jsonl'),'utf8')).trim());
 assert.equal(event.source,'countdown-default-confirmed');assert.equal(event.augment,'乙');
 await assert.rejects(service.confirm({id:prompt.id,name:'乙',timeoutDefault:true}),e=>e.status===409);
});
