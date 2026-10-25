import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {once} from 'node:events';

export function claimInstance(stateDir) {
 const identity=createHash('sha256').update(resolve(stateDir).toLowerCase()).digest('hex');
 const script=fileURLToPath(new URL('./instance.ps1',import.meta.url));
 const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-Identity',identity],
  {windowsHide:true,cwd:dirname(script),stdio:['pipe','pipe','ignore']});
 child.stdin.on('error',()=>{});
 let closing=false;
 const close=async()=>{
  if(closing)return;closing=true;
  if(child.exitCode!==null)return;
  const exited=once(child,'exit');
  const timer=setTimeout(()=>child.kill(),2000);
  child.stdin.end();
  try{await exited;}finally{clearTimeout(timer);}
 };
 return new Promise((resolve,reject)=>{
  let output='',ready=false;
  const timer=setTimeout(()=>{void close();reject(Error('Instance check timed out'));},10000);
  const fail=()=>{clearTimeout(timer);if(!ready)reject(Error('Instance check failed'));};
  child.once('error',fail);child.once('exit',fail);
  child.stdout.on('data',chunk=>{
   if(ready)return;
   output+=chunk;
   if(output.length>1024){void close();fail();return;}
   if(!output.includes('\n'))return;
   const status=output.trim();
   if(!['owned','busy'].includes(status)){void close();fail();return;}
   ready=true;clearTimeout(timer);
   resolve({owned:status==='owned',close});
  });
 });
}
