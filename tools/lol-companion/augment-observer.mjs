import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const exec = promisify(execFile);
const normalize = value => String(value??'').replace(/[\s:：!！·•,，。.]/g,'').replaceAll('亻卜','仆');

export function createAugmentObserver(names, emit) {
  const catalog = new Map(names.map(name=>[normalize(name),name]));
  let current=[],history=[],round=0,misses=0,pending='',confirmations=0,slots=[];
  return {
    reset(){current=[];history=[];round=0;misses=0;pending='';confirmations=0;slots=[];},
    observe(frame){
      if(!frame?.foreground || !frame.available)return;
      const found=(frame.lines??[]).map(line=>({...line,name:catalog.get(normalize(line.text))})).filter(line=>line.name);
      let candidates=[];
      for(const seed of found){
        const band=found.filter(line=>Math.abs(line.y-seed.y)<frame.height*0.07).sort((a,b)=>a.x-b.x);
        if(band.length===3&&new Set(band.map(line=>line.name)).size===3&&band[1].x-band[0].x>frame.width*0.12&&band[2].x-band[1].x>frame.width*0.12){candidates=band.map(line=>line.name);break;}
      }
      if(candidates.length!==3){
        if(found.length>=2){misses=0;return;}
        if(++misses>=3&&current.length){emit({kind:'augment_offer_closed',roll:round});current=[];history=[];slots=[];pending='';confirmations=0;}
        return;
      }
      misses=0;const fingerprint=JSON.stringify(candidates);
      if(fingerprint===JSON.stringify(current))return;
      if(fingerprint!==pending){pending=fingerprint;confirmations=1;return;}
      if(++confirmations<2)return;
      const reroll=current.length===3;
      if(reroll&&candidates.some((name,i)=>slots[i].length>=2&&name!==current[i]))return;
      if(!reroll){round++;history=[];slots=candidates.map(name=>[name]);}
      else candidates.forEach((name,i)=>{if(name!==current[i])slots[i].push(name);});
      current=candidates;history=[...new Set([...history,...current])].slice(0,6);
      emit({kind:'augment_offer',roll:round,reroll,options:current.map((name,slot)=>({name,slot,rerollsUsed:slots[slot].length-1})),seen:history});
    },
  };
}

export async function captureAugmentPanel(signal) {
  const ps=join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const script=fileURLToPath(new URL('./capture-augments.ps1',import.meta.url));
  const {stdout}=await exec(ps,['-NoProfile','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,timeout:10000,signal,maxBuffer:256*1024});
  return JSON.parse(stdout.replace(/^\uFEFF/,''));
}
export async function augmentNames(){return JSON.parse(await readFile(new URL('./augment-names.json',import.meta.url),'utf8'));}
