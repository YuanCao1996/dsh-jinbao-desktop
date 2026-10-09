// Lightweight log collection: no strategy database, OCR or model credential.
import { readCredentials } from './lockfile.mjs';
import { lcuRequest } from './lcu.mjs';
import { getAllGameData,compactState,diffEvents } from './live.mjs';
import { createEventLog } from './eventlog.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
const folder=process.env.JINBAO_LOG_DIR??join(homedir(),'.dsh','jinbao','logs');
let log=createEventLog(folder,'client-'+Date.now()),phase=null,lastEvent=-1,gameTime=null;
console.log('LoL collector started; waiting for client. Logs: '+folder);
let running=true;process.once('SIGINT',()=>{running=false;});process.once('SIGTERM',()=>{running=false;});
while(running){
 try{
  const credentials=readCredentials();
  if(credentials.ok){const result=await lcuRequest(credentials,'/lol-gameflow/v1/gameflow-phase');
   if(result.status===200&&result.data!==phase){phase=result.data;log.append({kind:'phase',phase});}
  }
  const all=await getAllGameData(),state=compactState(all);
  if(state){
   const time=all.gameData.gameTime;
   if(gameTime===null||time<gameTime){log=createEventLog(folder,'live-'+Date.now());lastEvent=-1;log.append({kind:'game_start',me:state.me??{},queue:'unknown'});}
   gameTime=time;log.append({kind:'state',state:{...state.me,time:state.gameTime,hpPct:state.me.maxHp?state.me.hp/state.me.maxHp:null,enemyItems:state.enemies.flatMap(p=>p.items??[])},me:state.me});
   const changed=diffEvents(lastEvent,all);lastEvent=changed.maxId;
   for(const e of changed.fresh)log.append({kind:'event',id:e.EventID,name:e.EventName,time:e.EventTime,killer:e.KillerName,victim:e.VictimName,turret:e.TurretKilled,dragon:e.DragonType,...e});
  }else gameTime=null;
 }catch{ /* Client can disappear between polling steps; no credential is logged. */ }
 await sleep(3000);
}
