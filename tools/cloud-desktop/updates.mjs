import {mkdir,writeFile,rename} from 'node:fs/promises';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {createUpdater} from '../jinbao-launcher/update.mjs';
export function createStandaloneUpdates({root,stateDir,restart,updater=createUpdater({root,stateDir,channel:'standalone'}),now=Date.now}){
 const lifetime=new AbortController();let checking=null,applying=false;
 return{check(){if(!checking)checking=updater.check(lifetime.signal).finally(()=>{checking=null;});return checking;},
  async apply(view){
   if(applying)throw Object.assign(Error('Update busy'),{status:409});
   if(view.match&&!view.ended&&(view.gameTime!=='等待对局'||view.phase==='ChampSelect')&&now()-view.updatedAt<30000)throw Object.assign(Error('Game active'),{status:409});
   const candidate=await updater.prepared();if(!candidate||!restart)throw Object.assign(Error('No verified update'),{status:409});
   applying=true;const status={id:randomUUID(),state:'applying',version:candidate.release.version,message:'正在退出金宝并启动新版，登录与设置会保留。',at:now()};
   await mkdir(join(stateDir,'updates'),{recursive:true});const path=join(stateDir,'updates/apply-status.json');await writeFile(path+'.tmp',JSON.stringify(status));await rename(path+'.tmp',path);
   try{await restart();return {message:status.message};}catch(error){applying=false;throw error;}
  },async close(){lifetime.abort();await checking;}};
}
