// Lightweight log collection: no strategy database, OCR or model credential.
import { readCredentials } from './lockfile.mjs';
import { lcuRequest } from './lcu.mjs';
import { getAllGameData,compactState,diffEvents } from './live.mjs';
import { createEventLog } from './eventlog.mjs';
import { stateEvent,createRosterStats } from './collector-state.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
const folder=process.env.JINBAO_LOG_DIR??join(homedir(),'.dsh','jinbao','logs');
let log=createEventLog(folder,'client-'+Date.now()),phase=null,lastEvent=-1,gameTime=null;
const lookupStats=createRosterStats(readCredentials);
let nextMatch=true;
console.log('LoL collector started; waiting for client. Logs: '+folder);
let running=true;process.once('SIGINT',()=>{running=false;});process.once('SIGTERM',()=>{running=false;});
while(running){
 try{
  const credentials=readCredentials();
  if(credentials.ok){const result=await lcuRequest(credentials,'/lol-gameflow/v1/gameflow-phase');
   if(result.status===200&&result.data!==phase){phase=result.data;log.append({kind:'phase',phase});if(['ChampSelect','EndOfGame','Lobby','None'].includes(phase))nextMatch=true;}
  }
  const all=await getAllGameData(),state=compactState(all);
  if(state){
   const time=all.gameData.gameTime;
   if(nextMatch||gameTime===null||time<gameTime){
    nextMatch=false;log=createEventLog(folder,'live-'+Date.now());lastEvent=-1;
    log.append({kind:'game_start',me:state.me??{},queue:state.mode,gameTime:state.gameTime,allies:state.allies,enemies:state.enemies});
    const matchLog=log;
    void lookupStats(state).then(event=>{if(log===matchLog)matchLog.append(event);}).catch(()=>{});
   }
   gameTime=time;log.append(stateEvent(state));
   const changed=diffEvents(lastEvent,all);lastEvent=changed.maxId;
   for(const e of changed.fresh)log.append({kind:'event',id:e.EventID,name:e.EventName,time:e.EventTime,killer:e.KillerName,victim:e.VictimName,turret:e.TurretKilled,dragon:e.DragonType,...e});
  }
 }catch{ /* Client can disappear between polling steps; no credential is logged. */ }
 await sleep(3000);
}
