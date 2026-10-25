import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
export function createAugmentCaptureWorker({spawnImpl=spawn,timeoutMs=8000}={}){
 let child=null,pending=null,buffer='',closed=false;
 const reset=error=>{const owned=child;child=null;buffer='';if(pending){const request=pending;pending=null;clearTimeout(request.timer);request.signal?.removeEventListener('abort',request.abort);request.reject(error);}owned?.kill();};
 function start(){
  const powershell=join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const owned=spawnImpl(powershell,['-NoProfile','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./capture-augments.ps1',import.meta.url)),'-Worker'],{windowsHide:true,stdio:['pipe','pipe','ignore']});child=owned;
  owned.stdin.on('error',()=>{if(child===owned)reset(Error('Capture worker unavailable'));});
  owned.on('error',()=>{if(child===owned)reset(Error('Capture worker unavailable'));});
  owned.on('exit',()=>{if(child===owned)reset(Error('Capture worker exited'));});
  owned.stdout.setEncoding('utf8');owned.stdout.on('data',chunk=>{
   if(child!==owned)return;buffer+=chunk;
   if(buffer.length>256*1024){reset(Error('Capture result too large'));return;}
   const end=buffer.indexOf('\n');if(end<0)return;
   const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);if(!pending)return;
   try{const value=JSON.parse(line),request=pending;pending=null;clearTimeout(request.timer);request.signal?.removeEventListener('abort',request.abort);request.resolve(value);}catch{reset(Error('Invalid capture result'));}
  });
 }
 return {capture(signal){
  if(closed||signal?.aborted)return Promise.reject(Error('Capture stopped'));
  if(pending)return Promise.reject(Error('Capture already in progress'));
  if(!child)start();
  return new Promise((resolve,reject)=>{
   const abort=()=>reset(Error('Capture stopped'));
   pending={resolve,reject,signal,abort,timer:setTimeout(()=>reset(Error('Capture timeout')),timeoutMs)};
   signal?.addEventListener('abort',abort,{once:true});child.stdin.write('capture\n');
  });
 },close(){closed=true;reset(Error('Capture stopped'));}};
}
