import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,appendFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initialOverlayState,applyOverlayEvent,overlayView,createOverlayService} from '../overlay-state.mjs';
import {phoneSnapshot} from '../phone-sync.mjs';

test('purchase and augment stream events populate their pages without confusing ownership or inventory; latest events append last',()=>{
 const s=initialOverlayState();let at=1;
 const emit=e=>applyOverlayEvent(s,{game:'lol',t:++at,...e},'one');
 emit({kind:'game_start',me:{champion:'安妮',items:[{name:'长剑'}]},enemies:[{champion:'锐雯',items:[{name:'无尽之刃'}]}]});
 emit({kind:'chat_events',events:[{kind:'purchase',champion:'安妮',time:'01:05',item:'残疫'},
  {kind:'augment_picked_chat',champion:'安妮',who:'self',time:'01:06',augment:'珠光护手',confidence:'high'},
  {kind:'augment_mutate',champion:'锐雯',who:'enemy',time:'01:07',augment:'双刀流'},
  {kind:'augment_picked',time:'01:08',name:'终极唤醒',source:'ocr-inferred',confidence:'low'}]});
 const v=overlayView(s);
 assert.doesNotMatch(v.equipment,/当前装备\n长剑\n/);assert.match(v.equipment,/装备动态.*\n01:05 安妮购买装备：残疫/);
 assert.doesNotMatch(v.equipment,/敌方装备|无尽之刃/);
 assert.deepEqual(s.ownedAugments,['珠光护手']);assert.match(v.augments,/强化动态\n01:06.*珠光护手/);
 assert.match(v.augments,/锐雯 · 双刀流/);assert.match(v.augments,/疑似海克斯选择.*终极唤醒/);
 assert.match(v.advice,/本局已选海克斯\n珠光护手/);assert.doesNotMatch(v.advice,/双刀流|终极唤醒/);
 const lines=v.events.split('\n');assert.match(lines[0],/^01:05/);assert.match(lines.at(-1),/^01:08/);
 const mirror=phoneSnapshot(v);assert.equal(mirror.augments,v.augments);assert.equal(mirror.advice,v.advice);assert.equal(mirror.equipment,v.equipment);
 emit({kind:'game_start',me:{champion:'安妮'}});assert.doesNotMatch(overlayView(s).equipment,/残疫/);assert.doesNotMatch(overlayView(s).augments,/珠光护手/);
});

test('capture failures are distinct from missing language; success clears the warning without discarding logged picks',()=>{
 const s=initialOverlayState();s.game='lol';s.me.champion='安妮';let t=0;
 const status=(available,reason)=>applyOverlayEvent(s,{game:'lol',kind:'augment_capture_status',t:++t,available,reason},'one');
 status(false,'ocr_runtime_unavailable');assert.match(overlayView(s).augments,/暂不可用.*自动重试/);assert.doesNotMatch(overlayView(s).augments,/未安装中文/);
 status(false,'chinese_language_unavailable');assert.match(overlayView(s).augments,/未安装中文识别语言包/);
 status(true,'capture_failed');assert.match(overlayView(s).augments,/画面暂未采集成功/);
 status(true,'');assert.doesNotMatch(overlayView(s).augments,/暂不可用|未安装中文|采集成功/);
});

test('live log changes refresh ranked Mayhem choices in battle and augment pages, including single-slot rerolls',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jinbao-page-sync-'));await mkdir(join(dir,'logs'));
 const file=join(dir,'logs/live.jsonl');let at=Date.now();
 const send=event=>appendFile(file,JSON.stringify({game:'lol',t:++at,...event})+'\n');
 await writeFile(file,'');await send({kind:'game_start',queue:'KIWI',me:{champion:'安妮'}});
 const ranks={一号:3,二号:1,三号:2,新选项:1};
 const service=await createOverlayService({stateDir:dir,pollMs:10,search:async q=>({results:q.filter?._type==='augments'&&q.filter.name?[{data:{_type:'augments',champion:'安妮',name:q.filter.name,rank:ranks[q.filter.name]}}]:[]})});
 t.after(service.close);
 const until=async check=>{for(let i=0;i<250;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}throw Error('page synchronization timeout');};
 await send({kind:'augment_offer',roll:1,options:['一号','二号','三号']});
 await until(()=>service.view().advice.includes('#1 · 二号')&&service.view().advice.includes('#2 · 三号'));
 let v=service.view();assert.ok(v.advice.indexOf('二号')<v.advice.indexOf('三号'));assert.ok(v.advice.indexOf('三号')<v.advice.indexOf('一号'));
 await send({kind:'augment_offer',roll:1,reroll:true,options:['新选项','二号','三号']});
 await until(()=>service.view().advice.includes('#1 · 新选项'));
 v=service.view();assert.doesNotMatch(v.advice,/一号/);assert.doesNotMatch(v.augments.split('英雄 Top10')[0],/一号/);
 await send({kind:'augment_offer_closed',roll:1});
 await until(()=>!service.view().advice.includes('当前三选一'));
 await send({kind:'augment_mutate',augment:'新选项',who:'self',confidence:'high'});
 await until(()=>service.view().advice.includes('本局已选海克斯\n新选项'));
 await send({kind:'purchase',who:'self',item:'残疫',time:'06:12'});
 await until(()=>service.view().equipment.includes('06:12 安妮购买装备：残疫'));
 assert.match(service.view().events.split('\n').at(-1),/购买装备：残疫/);
});
