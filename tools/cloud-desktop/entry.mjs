import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';import {fileURLToPath} from 'node:url';import {homedir} from 'node:os';
import {createUpdater} from '../jinbao-launcher/update.mjs';
export async function runEntry({root,stateDir,args=[],spawnImpl=spawn,updater=createUpdater({root,stateDir,channel:'standalone'}),startupTimeoutMs=30000}){
 let candidate=await updater.resolve(),fallback=false;
 while(true){
  let ready=false,restart=false,child,timer;const current=createUpdater({root:candidate,stateDir,channel:'standalone'});
  const code=await new Promise((accept,reject)=>{
   child=spawnImpl(join(candidate,'runtime/node.exe'),[join(candidate,'tools/cloud-desktop/main.mjs'),'--state',stateDir,...args],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
   timer=setTimeout(()=>child.kill(),startupTimeoutMs);
   child.on('message',message=>{
    if(message?.action==='ready'){ready=true;clearTimeout(timer);void current.healthy().catch(()=>{});process.stdout.write(JSON.stringify({standalone:true,managedEntry:true})+'\n');}
    if(message?.action==='restart-update')restart=true;
   });child.once('error',reject);child.once('exit',accept);
  }).catch(()=>-1).finally(()=>clearTimeout(timer));
  if(!ready&&candidate!==root&&!fallback){await current.reject();candidate=root;fallback=true;continue;}
  if(restart&&ready){candidate=await updater.resolve();fallback=false;continue;}
  return ready?code??0:1;
 }
}
if(resolve(process.argv[1]??'')===fileURLToPath(import.meta.url)){
 const root=fileURLToPath(new URL('../../',import.meta.url)),args=process.argv.slice(2),index=args.indexOf('--state');
 const stateDir=resolve(index>=0?args.splice(index,2)[1]:join(homedir(),'.jinbao-cloud-preview'));
 process.exitCode=await runEntry({root,stateDir,args});
}
