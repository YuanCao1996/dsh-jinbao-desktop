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
import {createItemCatalogue} from './item-policy.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
const folder=process.env.JINBAO_LOG_DIR??join(homedir(),'.dsh','jinbao','logs');
let log=createEventLog(folder,'client-'+Date.now()),phase=null,lastEvent=-1,gameTime=null;
let nextMatch=true;
const readSelection=createChampionSelectionReader(lcuRequest);
let selectionLog=null,selectionMatch=null;
console.log('LoL collector started; waiting for client. Logs: '+folder);
let running=true,lastLiveState=null,capturing=false,lastCaptureAvailable=null,nextCaptureAt=0,captureGeneration=0;
const captureStop=new AbortController();
const captureWorker=createAugmentCaptureWorker();
const names=await augmentNames();
const observer=createAugmentObserver(names,event=>{if(running)log.append(event);});
const chatObserver=createChatObserver(names,event=>{if(running)log.append(event);});
const readChatCatalog=createChatCatalogReader(lcuRequest);
let enrichItem=item=>item,championNames=new Map();
const acceptCatalog=catalog=>{chatObserver.setCatalog(catalog);if(catalog.items)enrichItem=createItemCatalogue(catalog.items);if(catalog.champions)championNames=new Map(catalog.champions.filter(c=>c.alias&&c.name).map(c=>[c.alias.toLowerCase(),c.name]));};
const stop=()=>{running=false;captureStop.abort();captureWorker.close();};
process.once('SIGINT',stop);process.once('SIGTERM',stop);
process.on('message',message=>{if(message?.action==='stop')stop();});
if(process.connected)process.once('disconnect',stop);
const captureTimer=setInterval(async()=>{
 if(!running||capturing||Date.now()<nextCaptureAt||!lastLiveState||!['KIWI','ARAM'].includes(lastLiveState.mode))return;
 capturing=true;nextCaptureAt=Date.now()+500;
 const generation=captureGeneration;
 try{
  const frame=await captureWorker.capture(captureStop.signal);
  if(running&&generation===captureGeneration&&lastLiveState){
   observer.observe(frame);
   const diagnostic=observer.status();
   const captureStatus=JSON.stringify([frame.available,frame.foreground===true,frame.reason??'',diagnostic.recognized,diagnostic.method]);
   if(captureStatus!==lastCaptureAvailable){lastCaptureAvailable=captureStatus;log.append({kind:'augment_capture_status',available:frame.available,foreground:frame.foreground===true,reason:frame.reason??'',...diagnostic});}
   if(!frame.available)nextCaptureAt=Date.now()+60000;
   chatObserver.observe(frame,lastLiveState);
  }
 }catch{if(running&&lastCaptureAvailable!=='capture-error'){lastCaptureAvailable='capture-error';log.append({kind:'augment_capture_status',available:true,reason:'capture_failed'});}}finally{capturing=false;}
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
    nextMatch=false;log=createEventLog(folder,'live-'+Date.now());lastEvent=-1;observer.reset();chatObserver.reset();captureGeneration++;lastCaptureAvailable=null;nextCaptureAt=0;
    log.append({kind:'game_start',me:state.me??{},queue:state.mode,gameTime:state.gameTime,allies:state.allies,enemies:state.enemies});
   }
   gameTime=time;log.append(stateEvent(state));
   if(credentials.ok)void readChatCatalog(credentials,acceptCatalog).catch(()=>{});
   const changed=diffEvents(lastEvent,all);lastEvent=changed.maxId;
   for(const e of changed.fresh)log.append({kind:'event',id:e.EventID,name:e.EventName,time:e.EventTime,killer:e.KillerName,victim:e.VictimName,turret:e.TurretKilled,dragon:e.DragonType,...e});
  }
 }catch{ /* Client can disappear between polling steps; no credential is logged. */ }
 await sleep(lastLiveState?1000:3000);
}
clearInterval(captureTimer);captureStop.abort();captureWorker.close();
if(process.connected)process.disconnect();
