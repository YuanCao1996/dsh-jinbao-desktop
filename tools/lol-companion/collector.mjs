// Lightweight log collection with native Windows OCR; no strategy database or model credential.
import { readCredentials } from './lockfile.mjs';
import { lcuRequest } from './lcu.mjs';
import { getAllGameData,compactState,diffEvents } from './live.mjs';
import { createEventLog } from './eventlog.mjs';
import { stateEvent } from './collector-state.mjs';
import { createChampionSelectionReader } from './champ-select.mjs';
import { createChatObserver,createChatCatalogReader } from './chat-observer.mjs';
import { createAugmentObserver,augmentNames } from './augment-observer.mjs';
import {createAugmentCaptureWorker} from './capture-worker.mjs';
import {createCaptureSchedule} from './capture-schedule.mjs';
import {createItemCatalogue} from './item-policy.mjs';
import {createHudAssets} from './hud-assets.mjs';
import {createAllyUltimateObserver} from './ally-ultimates.mjs';
import { homedir } from 'node:os';
import { join,dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {writeFile,rename} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const folder=process.env.JINBAO_LOG_DIR??join(homedir(),'.dsh','jinbao','logs');
let log=createEventLog(folder,'client-'+Date.now()),phase=null,lastEvent=-1,gameTime=null;
let nextMatch=true;
const readSelection=createChampionSelectionReader(lcuRequest);
let selectionLog=null,selectionMatch=null;
console.log('LoL collector started; waiting for client. Logs: '+folder);
let running=true,lastLiveState=null,capturing=false,lastCaptureAvailable=null,nextCaptureAt=0,captureGeneration=0;
const captureStop=new AbortController();
const captureWorker=createAugmentCaptureWorker();
const captureSchedule=createCaptureSchedule();
const names=await augmentNames();
let captureReportBusy=false,lastCaptureReport=0,captureSequence=0;
const captureReport=async value=>{
 if(captureReportBusy||Date.now()-lastCaptureReport<1000)return;
 captureReportBusy=true;lastCaptureReport=Date.now();
 const path=join(process.env.JINBAO_STATE_DIR??dirname(folder),'augment-diagnostics.json');
 try{await writeFile(path+'.tmp',JSON.stringify({at:Date.now(),sequence:++captureSequence,...value}),{mode:0o600});await rename(path+'.tmp',path);}catch{}finally{captureReportBusy=false;}
};
// 视觉判定：面板出现时另起一个进程，20Hz 采样三张卡，找出"只有它在变"的那张。
// 必须是独立进程——它要跑满整个面板期，占用 capture worker 会让采集停摆十几秒。
const cardWatchScript=fileURLToPath(new URL('./card-watch.ps1',import.meta.url));
let cardWatch=null;
const stopCardWatch=()=>{if(cardWatch){const owned=cardWatch;cardWatch=null;try{owned.kill()}catch{}}};
const startCardWatch=offer=>{
 stopCardWatch();
 const powershell=join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
 let child;
 try{child=spawn(powershell,['-NoProfile','-ExecutionPolicy','Bypass','-File',cardWatchScript,'-Watch','-TimeoutMs','12000'],{windowsHide:true,stdio:['ignore','pipe','ignore']});}catch{return;}
 cardWatch=child;
 const finish=()=>{if(cardWatch===child)cardWatch=null;};
 let buffer='';
 const onLine=line=>{
  let result;try{result=JSON.parse(line);}catch{return;}
  if(!running||!offer)return;
  if(!Number.isInteger(result.picked)){
   // 判定不出来时把两帧路径留下：既是视觉兜底的输入，也是阈值标定的原始数据。
   if(result.baselineImage&&result.lastImage)log.append({kind:'augment_vision_ambiguous',options:(Array.isArray(offer.options)?offer.options:[]).slice(0,3),roll:offer.roll??null,reason:result.reason??'',frames:result.frames??0,peak:result.peak??null,baselineImage:result.baselineImage,lastImage:result.lastImage});
   return;
  }
  const options=Array.isArray(offer.options)?offer.options:[];
  const option=options.find(row=>Number(row?.slot)===result.picked)??options[result.picked];
  const name=typeof option==='string'?option:option?.name;
  if(typeof name!=='string'||!name)return;
  // 判定成功的这一条会把该轮标记为已确认，确认弹窗因此不再出现。
  log.append({kind:'augment_picked',who:'self',name,augment:name,roll:offer.roll??null,source:'vision-click',confidence:'high',gameTime:lastLiveState?.gameTime??gameTime??null,visionReason:result.reason??'',visionFrames:result.frames??0});
 };
 child.stdout?.setEncoding('utf8');
 child.stdout?.on('data',chunk=>{buffer+=chunk;if(buffer.length>8192){stopCardWatch();return;}let end=buffer.indexOf('\n');while(end>=0){onLine(buffer.slice(0,end).trim());buffer=buffer.slice(end+1);end=buffer.indexOf('\n');}});
 child.on('error',finish);child.on('exit',finish);
};
const observer=createAugmentObserver(names,event=>{
 if(!running)return;
 log.append(event);
 if(event.kind==='augment_offer')startCardWatch(event);
 // 面板关闭不杀监视器：它的判定结果可能还差一帧才输出，让它自然结束（淡出即停或超时）。
});
const chatObserver=createChatObserver(names,event=>{if(running)log.append(event);});
const readChatCatalog=createChatCatalogReader(lcuRequest);
let enrichItem=item=>item,championNames=new Map(),champions=[];
const ultimateObserver=createAllyUltimateObserver(event=>{if(running)log.append(event);});
const hudAssets=createHudAssets({stateDir:process.env.JINBAO_STATE_DIR??dirname(folder),load:async(id,signal)=>{
 const credentials=readCredentials();if(!credentials.ok)throw Error('Client unavailable');
 const result=await lcuRequest(credentials,`/lol-game-data/assets/v1/champion-icons/${id}.png`,{binary:true,timeoutMs:3000,signal});
 if(result.status!==200)throw Error('Portrait unavailable');return result.data;
}});
const acceptCatalog=catalog=>{chatObserver.setCatalog(catalog);if(catalog.items)enrichItem=createItemCatalogue(catalog.items);if(catalog.champions){champions=catalog.champions;championNames=new Map(champions.filter(c=>c.alias&&c.name).map(c=>[c.alias.toLowerCase(),c.name]));}};
const stop=()=>{running=false;stopCardWatch();captureStop.abort();captureWorker.close();void hudAssets.close();};
process.once('SIGINT',stop);process.once('SIGTERM',stop);
process.on('message',message=>{if(message?.action==='stop')stop();});
if(process.connected)process.once('disconnect',stop);
const captureTimer=setInterval(async()=>{
 if(!running||capturing||Date.now()<nextCaptureAt||!lastLiveState||!['KIWI','ARAM'].includes(lastLiveState.mode))return;
 capturing=true;nextCaptureAt=Date.now()+500;
 const generation=captureGeneration;
 const captureStarted=Date.now();
 try{
  const frame=await captureWorker.capture(captureStop.signal,{focus:captureSchedule.choose(observer.status().knownSlots??0)});
  if(running&&generation===captureGeneration&&lastLiveState){
   observer.observe(frame);
   if(frame.focus!=='titles')ultimateObserver.observe(frame,lastLiveState,hudAssets.key());
   const diagnostic=observer.status();
   void captureReport({available:frame.available===true,foreground:frame.foreground===true,panelOccluded:frame.panelOccluded===true,focus:frame.focus,recognized:diagnostic.recognized,knownSlots:diagnostic.knownSlots,reason:diagnostic.reason??frame.reason,captureBackend:frame.captureBackend,elapsedMs:Date.now()-captureStarted,ageMs:Number.isFinite(frame.capturedAt)?Date.now()-frame.capturedAt:undefined});
   const captureStatus=JSON.stringify([frame.available,frame.foreground===true,diagnostic.reason??frame.reason??'',diagnostic.recognized,diagnostic.method]);
   if(captureStatus!==lastCaptureAvailable){lastCaptureAvailable=captureStatus;log.append({kind:'augment_capture_status',available:frame.ocrAvailable??frame.available,foreground:frame.foreground===true,reason:frame.reason??'',...diagnostic,captureBackend:frame.captureBackend,timings:frame.timings});}
   if(!frame.available)nextCaptureAt=Date.now()+60000;
   if(frame.focus!=='titles'&&!frame.panelOccluded)chatObserver.observe(frame,lastLiveState);
  }
 }catch{if(running){void captureReport({available:false,reason:'capture_failed',elapsedMs:Date.now()-captureStarted});if(lastCaptureAvailable!=='capture-error'){lastCaptureAvailable='capture-error';log.append({kind:'augment_capture_status',available:true,reason:'capture_failed'});}}}finally{capturing=false;}
},250);captureTimer.unref();
while(running){
 try{
  const credentials=readCredentials();
  if(credentials.ok){const result=await lcuRequest(credentials,'/lol-gameflow/v1/gameflow-phase');
   if(result.status===200&&result.data!==phase){phase=result.data;log.append({kind:'phase',phase});if(['ChampSelect','EndOfGame','Lobby','None'].includes(phase))nextMatch=true;}
   if(phase==='ChampSelect'){
    const selection=await readSelection(credentials);
    if(selection){
     if(!selectionLog){selectionMatch='select-'+Date.now();selectionLog=createEventLog(folder,selectionMatch);}
     selectionLog.append({kind:'champ_select',match:selectionMatch,...selection});
    }
   }else if(selectionLog){
    selectionLog.append({kind:'champ_select_end',match:selectionMatch,cancelled:['Lobby','None','EndOfGame'].includes(phase)});
    selectionLog=null;selectionMatch=null;
   }
  }
  const all=phase==='ChampSelect'?null:await getAllGameData(),state=compactState(all);
  lastLiveState=state;
  if(state){
   for(const player of [state.me,...state.allies,...state.enemies]){
    const name=championNames.get(String(player.championAlias??'').toLowerCase());if(name){player.championTitle=player.champion;player.champion=name;}
    player.items=(player.items??[]).map(enrichItem);
   }
   const time=all.gameData.gameTime;
   if(nextMatch||gameTime===null||time<gameTime){
    nextMatch=false;log=createEventLog(folder,'live-'+Date.now());lastEvent=-1;observer.reset();chatObserver.reset();ultimateObserver.reset();hudAssets.reset();captureSchedule.reset();captureGeneration++;lastCaptureAvailable=null;nextCaptureAt=0;
    log.append({kind:'game_start',me:state.me??{},queue:state.mode,gameTime:state.gameTime,allies:state.allies,enemies:state.enemies});
   }
   gameTime=time;log.append(stateEvent(state));
   if(credentials.ok)void hudAssets.update({state,champions,match:log.file,source:credentials.port});
   if(credentials.ok)void readChatCatalog(credentials,acceptCatalog).catch(()=>{});
   const changed=diffEvents(lastEvent,all);lastEvent=changed.maxId;
   for(const e of changed.fresh)log.append({kind:'event',id:e.EventID,name:e.EventName,time:e.EventTime,killer:e.KillerName,victim:e.VictimName,turret:e.TurretKilled,dragon:e.DragonType,...e});
  }
 }catch{ /* Client can disappear between polling steps; no credential is logged. */ }
 await sleep(lastLiveState?1000:3000);
}
clearInterval(captureTimer);captureStop.abort();captureWorker.close();
await hudAssets.close();
if(process.connected)process.disconnect();
