// Lightweight log collection with native Windows OCR; no strategy database or model credential.
import { readCredentials } from './lockfile.mjs';
import { lcuRequest } from './lcu.mjs';
import { getAllGameData,compactState,diffEvents } from './live.mjs';
import { createEventLog } from './eventlog.mjs';
import { stateEvent } from './collector-state.mjs';
import { createAugmentObserver,captureAugmentPanel,augmentNames } from './augment-observer.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
const folder=process.env.JINBAO_LOG_DIR??join(homedir(),'.dsh','jinbao','logs');
let log=createEventLog(folder,'client-'+Date.now()),phase=null,lastEvent=-1,gameTime=null;
let nextMatch=true;
console.log('LoL collector started; waiting for client. Logs: '+folder);
let running=true,lastLiveState=null,capturing=false,lastCaptureAvailable=null,nextCaptureAt=0,captureGeneration=0;
const captureStop=new AbortController();
const observer=createAugmentObserver(await augmentNames(),event=>{if(running)log.append(event);});
const stop=()=>{running=false;captureStop.abort();};
process.once('SIGINT',stop);process.once('SIGTERM',stop);
process.on('message',message=>{if(message?.action==='stop')stop();});
if(process.connected)process.once('disconnect',stop);
const captureTimer=setInterval(async()=>{
 if(!running||capturing||Date.now()<nextCaptureAt||!lastLiveState||!['KIWI','ARAM'].includes(lastLiveState.mode))return;
 capturing=true;
 const generation=captureGeneration;
 try{
  const frame=await captureAugmentPanel(captureStop.signal);
  if(running&&generation===captureGeneration&&lastLiveState){
   if(frame.available!==lastCaptureAvailable){lastCaptureAvailable=frame.available;log.append({kind:'augment_capture_status',available:frame.available});}
   if(!frame.available)nextCaptureAt=Date.now()+60000;
   observer.observe(frame);
  }
 }catch{}finally{capturing=false;}
},1500);captureTimer.unref();
while(running){
 try{
  const credentials=readCredentials();
  if(credentials.ok){const result=await lcuRequest(credentials,'/lol-gameflow/v1/gameflow-phase');
   if(result.status===200&&result.data!==phase){phase=result.data;log.append({kind:'phase',phase});if(['ChampSelect','EndOfGame','Lobby','None'].includes(phase))nextMatch=true;}
  }
  const all=await getAllGameData(),state=compactState(all);
  lastLiveState=state;
  if(state){
   const time=all.gameData.gameTime;
   if(nextMatch||gameTime===null||time<gameTime){
    nextMatch=false;log=createEventLog(folder,'live-'+Date.now());lastEvent=-1;observer.reset();captureGeneration++;lastCaptureAvailable=null;nextCaptureAt=0;
    log.append({kind:'game_start',me:state.me??{},queue:state.mode,gameTime:state.gameTime,allies:state.allies,enemies:state.enemies});
   }
   gameTime=time;log.append(stateEvent(state));
   const changed=diffEvents(lastEvent,all);lastEvent=changed.maxId;
   for(const e of changed.fresh)log.append({kind:'event',id:e.EventID,name:e.EventName,time:e.EventTime,killer:e.KillerName,victim:e.VictimName,turret:e.TurretKilled,dragon:e.DragonType,...e});
  }
 }catch{ /* Client can disappear between polling steps; no credential is logged. */ }
 await sleep(3000);
}
clearInterval(captureTimer);captureStop.abort();
if(process.connected)process.disconnect();
