import {execFile} from 'node:child_process';

// Abort notification may precede process exit. Do not release the audio slot
// until this instance's child has actually closed its output handles.
export function runSpeechProcess(script,input,{signal,timeout=60000,maxBuffer=4096,onSpawn=()=>{},run=execFile}={}){
 return new Promise((resolve,reject)=>{
  let error=null,stdout='';
  const child=run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,signal,timeout,maxBuffer,encoding:'utf8'},(failure,output)=>{error=failure;stdout=output;});
  child.once('close',code=>{
   if(error||code!==0||signal?.aborted)reject(Object.assign(Error('Speech process stopped'),{code:signal?.aborted?'speech_cancelled':'speech_process_failed'}));
   else resolve(stdout);
  });
  child.stdin?.on('error',()=>{});child.stdin?.end(JSON.stringify(input));
  try{onSpawn(child.pid);}catch{}
 });
}
