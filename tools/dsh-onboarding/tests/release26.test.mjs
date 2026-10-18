import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createAugmentObserver,augmentNames} from '../../lol-companion/augment-observer.mjs';
import {initialOverlayState,overlayView,createOverlayService} from '../overlay-state.mjs';
import {dispatchGameChat} from '../../dsh-coach-server/lib/chat-bridge.js';
import {createSetupServer} from '../server.mjs';

test('new names, wrapped titles and duplicated OCR boxes still emit current three candidates',async()=>{
 const names=await augmentNames();assert.ok(names.includes('术士果汁盒'));
 const events=[],o=createAugmentObserver(names,e=>events.push(e));
 const f={available:true,foreground:true,width:1200,height:600,lines:[{text:'术士',x:100,y:100},{text:'果汁盒',x:100,y:120},{text:'尤里卡',x:500,y:100},{text:'尤里卡',x:502,y:101},{text:'缩小引擎',x:900,y:100}]};
 o.observe(f);o.observe(f);assert.equal(events.length,1);assert.deepEqual(events[0].options.map(o=>o.name),['术士果汁盒','尤里卡','缩小引擎']);
});
test('combination display decodes exported arrays and never shows source fields or effect details',()=>{
 const s=initialOverlayState();s.game='lol';s.me.champion='安妮';
 const view=overlayView(s,{rows:[{_type:'combos',champion:'安妮',augments:'[{"name":"尤里卡"},{"name":"术士果汁盒"}]',winRate:67.47,source:'private'}]});
 assert.match(view.augments,/尤里卡 \+ 术士果汁盒 · 样本胜率 67.47%/);assert.doesNotMatch(view.augments,/private/);
});
test('equipment facts longer than user chat limit reach the same authenticated native Agent',async()=>{
 const req={headers:{authorization:'Bearer secret'},socket:{remoteAddress:'127.0.0.1'}};let seen;
 const args={req,credentials:{resolve:async()=>({value:'secret'})},monitors:{get:()=>({submitInteraction:async(_e,_m,data)=>{seen=data.question;return '先购买残疫';}})},body:{game:'lol',match:'one',topic:'equipment',question:'装'.repeat(8000)}};
 assert.equal((await dispatchGameChat(args)).answer,'先购买残疫');assert.equal(seen.length,8000);
 await assert.rejects(dispatchGameChat({...args,body:{...args.body,topic:'chat'}}),e=>e.status===400);
 await assert.rejects(dispatchGameChat({...args,body:{...args.body,question:'装'.repeat(16001)}}),e=>e.status===400);
});
test('one candidate failure retains other rankings and database builds',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jinbao-rank-fail-'));await mkdir(join(dir,'logs'));const at=Date.now();
 await writeFile(join(dir,'logs/live.jsonl'),[{game:'lol',kind:'game_start',t:at,me:{champion:'安妮'}},{game:'lol',kind:'augment_offer',t:at+1,roll:1,options:['甲','乙','丙']}].map(JSON.stringify).join('\n')+'\n');
 const svc=await createOverlayService({stateDir:dir,pollMs:10,search:async q=>{if(q.filter?.name==='乙')throw Error('transient');return {results:q.filter?._type==='augments'?[{data:{_type:'augments',champion:'安妮',name:q.filter.name??'甲',rank:2}}]:q.filter?._type==='coreBuilds'?[{data:{_type:'coreBuilds',champion:'安妮',items:'["残疫"]'}}]:[]};}});t.after(svc.close);
 for(let i=0;i<100&&!svc.view().augments.includes('#2 · 甲');i++)await new Promise(r=>setTimeout(r,20));
 assert.match(svc.view().augments,/#2 · 甲/);assert.match(svc.view().augments,/乙 · 暂无该英雄排名/);assert.match(svc.view().equipment,/残疫/);
});
test('settings check-update requires local authentication and live launcher, and exposes running version',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jinbao-update-ui-'));
 const setup=await createSetupServer({stateDir:dir,port:0,credentials:{resolve:async()=>null,set:async()=>{}},fetchImpl:async()=>Response.json({})});t.after(setup.close);
 const [base,nonce]=setup.url.split('/#');const call=(path,data)=>fetch(base+'/api/'+path,{method:data?'POST':'GET',headers:{'X-Jinbao-Setup':nonce,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});
 assert.equal((await call('update/check',{})).status,409);
 await writeFile(join(dir,'launcher-state.json'),JSON.stringify({phase:'waiting',version:'0.1.26',updatedAt:Date.now()}));
 assert.equal((await call('update/check',{})).status,202);assert.equal(JSON.parse(await readFile(join(dir,'launcher-control.json'))).action,'check-update');
 assert.equal((await(await call('status')).json()).version,'0.1.26');
 assert.equal((await fetch(base+'/api/update/check',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
});
