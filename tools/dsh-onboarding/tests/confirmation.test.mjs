import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initialOverlayState,applyOverlayEvent,createOverlayService} from '../overlay-state.mjs';
import {augmentConfirmation} from '../augment-confirmation.mjs';
const ranks=[{_type:'augments',champion:'安妮',name:'乙',rank:1},{_type:'augments',champion:'安妮',name:'甲',rank:3}];
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
