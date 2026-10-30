import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const exec = promisify(execFile);
const normalize = value => String(value??'').replace(/[\s:：!！·•,，。.]/g,'').replaceAll('亻卜','仆');

export function createAugmentObserver(names, emit, {now=Date.now,maxFrameAgeMs=4000,maxBlindGapMs=15000}={}) {
  const catalog = new Map(names.map(name=>[normalize(name),name]));
  let current=[null,null,null],history=[],round=0,misses=0,slots=[[],[],[]],anchors=null;
  let pending=[null,null,null],suspended=null;
  let lastValidAt=null,lastCapturedAt=null;
  const clearPanel=()=>{current=[null,null,null];history=[];slots=[[],[],[]];anchors=null;pending=[null,null,null];misses=0;};
  const suspendPanel=at=>{suspended={current:[...current],history:[...history],round,slots:slots.map(s=>[...s]),anchors,at};clearPanel();};
  let diagnostic={recognized:0,method:'none'};
  return {
    status(){return {...diagnostic};},
    reset(){clearPanel();round=0;suspended=null;lastValidAt=null;lastCapturedAt=null;diagnostic={recognized:0,method:'none'};},
    observe(frame){
      if(!frame?.foreground || !frame.available || frame.panelOccluded===true){pending=[null,null,null];diagnostic={recognized:0,method:frame?.method??'none',...(frame?.panelOccluded?{reason:'scoreboard_visible'}:{})};return;}
      const at=now();
      if(frame.capturedAt!==undefined){
        if(!Number.isFinite(frame.capturedAt)||at-frame.capturedAt>maxFrameAgeMs||frame.capturedAt>at+500){pending=[null,null,null];diagnostic={recognized:0,knownSlots:current.filter(Boolean).length,method:frame.method??'none',reason:'capture_stale'};return;}
        if(lastCapturedAt!==null&&frame.capturedAt<=lastCapturedAt){diagnostic={...diagnostic,reason:'duplicate_capture'};return;}
        lastCapturedAt=frame.capturedAt;
      }
      // Lost visibility is not a confirmed selection. Reacquire a fresh panel
      // without letting an old round's exhausted rerolls freeze every new slot.
      if(lastValidAt!==null&&at-lastValidAt>maxBlindGapMs&&current.some(Boolean))suspendPanel(at);
      lastValidAt=at;
      const lines=[...(frame.titleLines??[]).map(line=>({...line,source:'title'})),...(frame.lines??[]).map(line=>({...line,source:'full'}))];
      const found=lines.map(line=>({...line,name:catalog.get(normalize(line.text))})).filter(line=>line.name);
      // Windows OCR can wrap a card title into two lines. Join only nearby
      // lines in the same card; never fuzzy-match an arbitrary description.
      for(const a of lines)for(const b of lines){
        if(a.source!==b.source||(a.source==='title'&&a.slot!==b.slot))continue;
        if(b.y<=a.y||b.y-a.y>frame.height*0.07||Math.abs(a.x-b.x)>frame.width*0.07)continue;
        const name=catalog.get(normalize(a.text+b.text));
        if(name)found.push({...a,name});
      }
      // Full-frame OCR establishes geometry only from three aligned titles.
      // Once established, a missing neighbour cannot block a stable slot update.
      if(!anchors)for(const seed of found.filter(line=>line.source==='full')){
        const band=found.filter(line=>line.source==='full'&&Math.abs(line.y-seed.y)<frame.height*0.07).sort((a,b)=>a.x-b.x).filter((line,i,all)=>!all.slice(0,i).some(old=>old.name===line.name&&Math.abs(old.x-line.x)<frame.width*0.07));
        if(band.length===3&&new Set(band.map(line=>line.name)).size===3&&band[1].x-band[0].x>frame.width*0.12&&band[2].x-band[1].x>frame.width*0.12){anchors=band.map(line=>({x:line.x/frame.width,y:line.y/frame.height}));break;}
      }
      const titles=found.filter(line=>line.source==='title'&&Number.isInteger(line.slot)&&line.slot>=0&&line.slot<3);
      const candidates=[0,1,2].map(slot=>{
        const local=[...new Set(titles.filter(line=>line.slot===slot).map(line=>line.name))];
        if(local.length)return local.length===1?local[0]:null;
        if(!anchors)return null;
        const anchor=anchors[slot],names=[...new Set(found.filter(line=>line.source==='full'&&Math.abs(line.x/frame.width-anchor.x)<0.08&&Math.abs(line.y/frame.height-anchor.y)<0.07).map(line=>line.name))];
        return names.length===1?names[0]:null;
      });
      const recognized=candidates.filter(Boolean).length;
      // An animation/overlay may hide the same panel briefly. Recover its slot
      // history instead of inventing a new selection round and fresh rerolls.
      if(!current.some(Boolean)&&suspended&&at-suspended.at<90000&&candidates.filter((name,i)=>name&&name===suspended.current[i]).length>=2
          && candidates.every((name,i)=>!name||name===suspended.current[i]||suspended.slots[i].length<2)){
        ({current,history,round,slots,anchors}=suspended);suspended=null;misses=0;
        emit({kind:'augment_offer',roll:round,reopened:true,options:current.map((name,slot)=>name?{name,slot,rerollsUsed:slots[slot].length-1}:null).filter(Boolean),seen:history});
      }
      diagnostic={recognized,method:frame.method??'full',knownSlots:current.filter(Boolean).length};
      // A new, stable title in an exhausted slot cannot be another reroll of
      // that old round. Require a second observation before reacquiring it.
      const exhaustedChanges=candidates.map((name,i)=>name&&current[i]&&name!==current[i]&&slots[i].length>=2?i:null).filter(i=>i!==null);
      if(recognized===3&&new Set(candidates).size===3&&exhaustedChanges.length&&exhaustedChanges.every(i=>pending[i]?.name===candidates[i]&&pending[i].count>=1))suspendPanel(at);
      // A single tooltip elsewhere in the game can contain an augment name.
      // Establish a panel from at least two distinct card slots, then track
      // each slot independently while the other cards are obscured.
      if(!current.some(Boolean)&&new Set(candidates.filter(Boolean)).size<2){pending=[null,null,null];return;}
      if(!recognized&&!titles.length){
        pending=[null,null,null];
        if(++misses>=5&&current.some(Boolean)){emit({kind:'augment_offer_closed',roll:round});suspendPanel(at);}
        return;
      }
      misses=0;
      const next=[...current],changed=[];
      const stableFirstFrame=!current.some(Boolean)&&frame.cardLayout==='stacked-title-regions'&&recognized===3&&new Set(candidates).size===3;
      // A single-slot reroll can be accepted immediately when two independent
      // OCR passes (full frame and enlarged title crop) agree on its exact name,
      // and both unchanged neighbours are still visible. Otherwise require the
      // normal consecutive-frame confirmation.
      const changedSlots=candidates.map((name,slot)=>name&&current[slot]&&name!==current[slot]?slot:null).filter(slot=>slot!==null);
      const corroborated=frame.cardLayout==='stacked-title-regions'&&recognized===3&&new Set(candidates).size===3&&changedSlots.length===1&&current.every(Boolean)
        ? changedSlots.filter(slot=>titles.some(title=>title.slot===slot&&title.name===candidates[slot]&&found.some(full=>full.source==='full'&&full.name===title.name&&Math.abs(full.x-title.x)<frame.width*.07&&Math.abs(full.y-title.y)<frame.height*.05))) : [];
      candidates.forEach((name,slot)=>{
        if(!name||name===current[slot]){pending[slot]=null;return;}
        pending[slot]=pending[slot]?.name===name?{name,count:pending[slot].count+1}:{name,count:1};
        if(pending[slot].count>=(stableFirstFrame||corroborated.includes(slot)?1:2)&&slots[slot].length<2){next[slot]=name;changed.push(slot);}
      });
      // Ambiguous or duplicate titles must not consume a slot's only reroll.
      const accepted=changed.filter(slot=>next.filter(name=>name===next[slot]).length===1);
      if(!accepted.length)return;
      const reroll=accepted.some(slot=>!!current[slot]);
      if(!current.some(Boolean))round++;
      for(const slot of accepted){current[slot]=next[slot];slots[slot].push(next[slot]);pending[slot]=null;}
      history=[...new Set([...history,...current.filter(Boolean)])].slice(0,6);
      emit({kind:'augment_offer',roll:round,reroll,options:current.map((name,slot)=>name?{name,slot,rerollsUsed:slots[slot].length-1}:null).filter(Boolean),seen:history,missingSlots:current.map((name,slot)=>name?null:slot).filter(slot=>slot!==null)});
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
