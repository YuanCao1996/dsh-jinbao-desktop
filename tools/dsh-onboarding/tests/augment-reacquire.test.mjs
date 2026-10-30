import test from 'node:test';
import assert from 'node:assert/strict';
import {createAugmentObserver} from '../../lol-companion/augment-observer.mjs';
function fixture(){
 let clock=1000;const output=[];
 const observer=createAugmentObserver(['甲','乙','丙','丁','戊','己','庚','辛','壬'],e=>output.push(e),{now:()=>clock});
 const frame=(names,extra={})=>({available:true,foreground:true,width:1920,height:1080,cardLayout:'stacked-title-regions',titleLines:names.map((text,slot)=>({text,slot,x:500+slot*370,y:430})),lines:[],...extra});
 const observe=(names,extra)=>observer.observe(frame(names,extra));
 return {observer,output,observe,setClock:v=>clock=v};
}
test('an old exhausted round cannot freeze a fresh panel after visibility was lost',()=>{
 const f=fixture();f.observe(['甲','乙','丙']);f.observe(['丁','戊','己']);f.observe(['丁','戊','己']);assert.equal(f.output.at(-1).roll,1);
 f.setClock(20000);f.observer.observe({available:true,foreground:false});f.setClock(21000);f.observe(['庚','辛','壬']);
 assert.deepEqual(f.output.at(-1).options.map(o=>o.name),['庚','辛','壬']);assert.equal(f.output.at(-1).roll,2);
 assert.equal(f.output.filter(e=>e.kind==='augment_offer_closed').length,0,'lost focus alone is not a selected augment');
});
test('a stable new title in an exhausted slot reacquires the panel instead of freezing',()=>{
 const f=fixture();f.observe(['甲','乙','丙']);f.observe(['丁','乙','丙']);f.observe(['丁','乙','丙']);
 const count=f.output.length;f.observe(['庚','乙','丙']);assert.equal(f.output.length,count,'one OCR glitch cannot start a new round');
 f.observe(['庚','乙','丙']);assert.equal(f.output.at(-1).roll,2);assert.equal(f.output.at(-1).options[0].name,'庚');
});
test('a reopened unchanged panel keeps its existing round and consumed reroll',()=>{
 const f=fixture();f.observe(['甲','乙','丙']);f.observe(['丁','乙','丙']);f.observe(['丁','乙','丙']);
 f.setClock(20000);f.observe(['丁','乙','丙']);assert.equal(f.output.at(-1).roll,1);assert.equal(f.output.at(-1).options[0].rerollsUsed,1);
});

test('holding scoreboard never turns hidden offers into an inferred selection',()=>{
 const f=fixture();f.observe(['甲','乙','丙']);const first=f.output.length;
 for(let i=0;i<12;i++){f.setClock(2000+i*500);f.observe([],{panelOccluded:true});}
 assert.equal(f.output.length,first);assert.equal(f.observer.status().reason,'scoreboard_visible');
 f.setClock(9000);f.observe(['甲','乙','丙']);assert.equal(f.output.at(-1).roll,1);
 assert.equal(f.output.some(e=>e.kind==='augment_offer_closed'),false);
});
test('old and duplicate capture receipts never count as independent reroll confirmation',()=>{
 const f=fixture();f.observe(['甲','乙','丙'],{capturedAt:1000});f.setClock(1500);f.observe(['丁','乙','丙'],{capturedAt:1500});
 const count=f.output.length;f.observe(['丁','乙','丙'],{capturedAt:1500});assert.equal(f.output.length,count);assert.equal(f.observer.status().reason,'duplicate_capture');
 f.setClock(6000);f.observe(['丁','乙','丙'],{capturedAt:1600});assert.equal(f.observer.status().reason,'capture_stale');assert.equal(f.output.length,count);
 f.observe(['丁','乙','丙'],{capturedAt:6000});f.setClock(6500);f.observe(['丁','乙','丙'],{capturedAt:6500});assert.equal(f.output.at(-1).options[0].name,'丁');
});
