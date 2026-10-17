import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialOverlayState,applyOverlayEvent,overlayView,createOverlayService } from '../overlay-state.mjs';
import { createAugmentObserver } from '../../lol-companion/augment-observer.mjs';
const row=(name,rank,extra={})=>({_type:'augments',champion:'黑暗之女 安妮',name,rank,tier:'T1',winRate:60,desc:'不能出现的效果详情',...extra});
const pause=()=>new Promise(r=>setTimeout(r,10));
async function until(check){for(let i=0;i<200;i++){if(check())return;await pause();}throw Error('timed out');}

test('hero-specific ranks beat win rate, omit details, and only rank the currently available slots',()=>{
 const s=initialOverlayState();s.game='lol';s.me.champion='安妮';
 const knowledge={rows:[row('一号',1,{winRate:40}),row('二号',2,{winRate:80}),row('三号',3),row('旧选项',4),row('其他英雄',1,{champion:'锐雯'})]};
 const all=overlayView(s,knowledge).augments;
 assert.ok(all.indexOf('一号')<all.indexOf('二号'));assert.doesNotMatch(all,/效果详情|其他英雄/);
 applyOverlayEvent(s,{game:'lol',kind:'augment_offer',t:1,roll:1,options:['旧选项','二号','三号']},'game');
 applyOverlayEvent(s,{game:'lol',kind:'augment_offer',t:2,roll:1,options:['一号','二号','三号']},'game');
 const current=overlayView(s,knowledge).augments;
 assert.doesNotMatch(current,/旧选项|效果详情/);assert.match(current,/4\/6/);assert.ok(current.indexOf('一号')<current.indexOf('二号'));
});

test('three independent rerolls keep one round and at most six observed choices',()=>{
 const names=['一号','二号','三号','四号','五号','六号','第七号'];const emitted=[];const observer=createAugmentObserver(names,e=>emitted.push(e));
 const frame=choices=>({available:true,foreground:true,width:1200,height:600,lines:choices.map((text,i)=>({text,x:100+i*400,y:100}))});
 const show=choices=>{observer.observe(frame(choices));observer.observe(frame(choices));};
 show(names.slice(0,3));show(['四号','二号','三号']);show(['四号','五号','三号']);show(['四号','五号','六号']);
 assert.equal(emitted.length,4);assert.ok(emitted.every(e=>e.roll===1));
 assert.deepEqual(emitted.at(-1).options.map(o=>o.name),['四号','五号','六号']);assert.equal(emitted.at(-1).seen.length,6);
 show(['第七号','五号','六号']);assert.equal(emitted.length,4);
 for(let i=0;i<3;i++)observer.observe(frame([]));show(names.slice(0,3));assert.equal(emitted.at(-1).roll,2);assert.equal(emitted.at(-1).seen.length,3);
});

test('a single OCR frame cannot replace choices and background windows are ignored',()=>{
 const events=[];const o=createAugmentObserver(['仆从大师','物理转魔法','尤里卡'],e=>events.push(e));
 const frame={available:true,foreground:true,width:1500,height:700,lines:[{text:'物 理 转 魔 法',x:80,y:180},{text:'亻 卜 从 大 师',x:600,y:180},{text:'尤 里 卡',x:1130,y:180}]};
 o.observe({...frame,foreground:false});o.observe(frame);assert.equal(events.length,0);o.observe(frame);assert.equal(events.length,1);
 assert.deepEqual(events[0].options.map(o=>o.name),['物理转魔法','仆从大师','尤里卡']);
});

test('manual refresh waits for results and a changed slot queries its new candidate',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jinbao-augments-'));await mkdir(join(dir,'logs'));
 const file=join(dir,'logs/live.jsonl');let at=Date.now(),version=1;const calls=[];
 await writeFile(file,JSON.stringify({game:'lol',t:at,kind:'game_start',me:{champion:'安妮'}})+'\n');
 const service=await createOverlayService({stateDir:dir,pollMs:10,complete:async()=> '{}',search:async q=>{
  calls.push(q);await pause();const rows=q.filter?._type==='augments'?[row('初始',3),row('新候选',version),row('另一个',2)]:[];
  return {results:rows.filter(r=>!q.filter?.name||r.name===q.filter.name).map(data=>({data}))};
 }});t.after(service.close);
 await until(()=>service.view().augments.includes('初始'));
 version=4;await service.refresh();assert.match(service.view().augments,/#4 · 新候选/);
 await appendFile(file,JSON.stringify({game:'lol',t:++at,kind:'augment_offer',roll:1,options:['初始','另一个','未知']})+'\n');
 await until(()=>service.view().augments.includes('当前三选一'));
 await appendFile(file,JSON.stringify({game:'lol',t:++at,kind:'augment_offer',roll:1,options:['新候选','另一个','未知']})+'\n');
 await until(()=>calls.some(q=>q.filter?.name==='新候选'));
 await service.refresh();assert.doesNotMatch(service.view().augments,/初始/);assert.match(service.view().augments,/#4 · 新候选/);
});


test('a delayed slot lookup never restores replaced choices and rerolls reuse hero knowledge',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jinbao-reroll-'));await mkdir(join(dir,'logs'));
 const file=join(dir,'logs/live.jsonl');let at=Date.now(),release;const calls=[];
 await writeFile(file,JSON.stringify({game:'lol',t:at,kind:'game_start',me:{champion:'安妮'}})+'\n');
 const service=await createOverlayService({stateDir:dir,pollMs:10,complete:async()=> '{}',search:async q=>{
  calls.push(q);if(q.filter?.name==='旧选项')await new Promise(r=>{release=r;});
  const rows=q.filter?._type==='augments'?[row(q.filter.name??'英雄推荐',q.filter.name==='新选项'?1:5)]:[];
  return {results:rows.map(data=>({data}))};
 }});t.after(service.close);
 await until(()=>service.view().augments.includes('英雄推荐'));
 const offer=options=>appendFile(file,JSON.stringify({game:'lol',t:++at,kind:'augment_offer',roll:1,options})+'\n');
 await offer(['旧选项','二号','三号']);await until(()=>!!release);
 await offer(['新选项','二号','三号']);await until(()=>service.view().augments.includes('新选项'));
 release();await until(()=>service.view().augments.includes('#1 · 新选项'));
 assert.doesNotMatch(service.view().augments,/旧选项/);
 assert.equal(calls.filter(q=>q.filter?._type==='coreBuilds').length,1);
 assert.equal(calls.filter(q=>q.filter?.name==='二号').length,1);
});


test('roster hero queries are cached across rerolls and populate hero tiers without player statistics',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jinbao-hero-rates-'));await mkdir(join(dir,'logs'));
 const file=join(dir,'logs/live.jsonl');const calls=[];let at=Date.now();
 await writeFile(file,JSON.stringify({game:'lol',t:at,kind:'game_start',me:{champion:'安妮'},allies:[{champion:'安妮'}],enemies:[{champion:'锐雯'}]})+'\n');
 const service=await createOverlayService({stateDir:dir,pollMs:10,complete:async()=> '{}',search:async q=>{
  calls.push(q);return {results:q.dataset==='aram-ranking'?[{data:{name:q.query,winRate:q.query==='安妮'?55:52,tier:q.query==='安妮'?0:1}}]:[]};
 }});t.after(service.close);
 await until(()=>service.view().playerRows.every(r=>r.winRate!==null));
 assert.deepEqual(service.view().playerRows.map(r=>r.tierText),['T0','T1']);
 await appendFile(file,JSON.stringify({game:'lol',t:++at,kind:'augment_offer',roll:1,options:['一号','二号','三号']})+'\n');
 await until(()=>calls.some(q=>q.filter?.name==='三号'));
 assert.equal(calls.filter(q=>q.dataset==='aram-ranking').length,2);
});
