import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runSpeechProcess} from './speech-process.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {limitedJson,serviceUrl} from '../dsh-game-services/client.mjs';
import {roles,roleById,briefSpeech,speechPause} from './roles.mjs';

const failure=(code,status=503)=>Object.assign(Error('语音服务暂不可用'),{code,status});
export function playNative(audio,signal){
 return runSpeechProcess(fileURLToPath(new URL('./audio-player.ps1',import.meta.url)),audio,{signal}).catch(()=>{throw failure(signal.aborted?'speech_cancelled':'speech_playback_failed');});
}
export function ownSpeech({getKey}){
 return async(text,role,signal)=>{
  const key=await getKey();if(!key)throw failure('speech_key_required',401);
  let stdout;try{stdout=await runSpeechProcess(fileURLToPath(new URL('./synthesize-speech.ps1',import.meta.url)),{text,role,key},{signal,timeout:35000,maxBuffer:2500000});}catch{throw failure(signal.aborted?'speech_cancelled':'speech_provider_unavailable');}
  try{return validateAudio(JSON.parse(stdout));}catch{throw failure('speech_audio_invalid',502);}
 };
}
function validateAudio(value){
 if(value.mediaType!=='audio/wav'||typeof value.audioBase64!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(value.audioBase64)||value.audioBase64.length>2400060)throw failure('speech_audio_invalid',502);
 const bytes=Buffer.from(value.audioBase64,'base64');if(bytes.length<44||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')throw failure('speech_audio_invalid',502);
 return {mediaType:'audio/wav',audioBase64:value.audioBase64};
}
export function cloudSpeech({getToken,fetchImpl=fetch,serviceBaseUrl='https://api.jinbaoai.top'}){
 const base=serviceUrl(serviceBaseUrl);
 return async(text,role,signal)=>{
  const token=await getToken();if(!token)throw failure('speech_login_required',401);
  const response=await fetchImpl(new URL('/desktop/agent-preview/speech',base),{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({text,role}),signal:AbortSignal.any([signal,AbortSignal.timeout(35000)]),redirect:'error'});
  if(!response.ok){await response.body?.cancel();throw failure(response.status===401?'speech_login_required':response.status===429?'speech_rate_limited':'speech_provider_unavailable',response.status);}
  const value=await limitedJson(response,2500000);
  return validateAudio(value);
 };
}

export async function createSpeech({stateDir,view=()=>({}),synthesize,play=playNative,now=Date.now,trace=()=>{},minIntervalMs=45000,pause=(ms,signal)=>sleep(ms,undefined,{signal})}){
 const path=join(stateDir,'speech-settings.json');await mkdir(stateDir,{recursive:true});
 let config={enabled:false,chat:true,role:'jinbao',source:'official'},closed=false,scope='',generation=0,queue=[],active=null,pumping=null,writes=Promise.resolve(),lastCode='',phase='idle',cooldownUntil=0;
 const seen=new Map(),recent=new Map();let nextSpeechAt=-Infinity;
 try{const saved=JSON.parse(await readFile(path,'utf8'));if(typeof saved.enabled==='boolean')config.enabled=saved.enabled;if(typeof saved.chat==='boolean')config.chat=saved.chat;if(roles.some(r=>r.id===saved.role))config.role=saved.role;if(['official','byok'].includes(saved.source))config.source=saved.source;}catch(error){if(error.code==='ENOENT')try{config.enabled=JSON.parse(await readFile(join(stateDir,'overlay-display.json'),'utf8')).speech===true;}catch{}}
 const currentKey=()=>{const v=view();return (v.game||'lol')+':'+(v.match||'waiting');};
 const emit=(action,value={})=>{try{trace({action,role:config.role,...value});}catch{}};
 const state=()=>({supported:true,...config,roleName:roleById(config.role).name,voice:roleById(config.role).voice,model:roleById(config.role).model,state:phase,queueDepth:queue.length,lastCode,roles,minIntervalMs,maxChars:60,pendingLimit:1,nextSpeechAt:Number.isFinite(nextSpeechAt)?nextSpeechAt:0,quietRemainingMs:Number.isFinite(nextSpeechAt)?Math.max(0,nextSpeechAt-now()):0});
 let statusWrite=Promise.resolve();
 const publish=()=>{statusWrite=statusWrite.catch(()=>{}).then(async()=>{await writeFile(join(stateDir,'speech-status.json.tmp'),JSON.stringify({at:now(),...state()}),{mode:0o600});await rename(join(stateDir,'speech-status.json.tmp'),join(stateDir,'speech-status.json'));}).catch(()=>{});};
 const stop=()=>{generation++;active?.controller.abort();queue=[];};
 const stale=item=>{const v=view();return item.scope!==currentKey()||item.expiresAt<=now()||(!item.preview&&(!config.enabled||item.topic==='advice'&&(v.ended||v.phase==='CapturePaused'||!Number.isFinite(v.updatedAt)||now()-v.updatedAt>30000||(v.revokedPlayback??[]).includes(item.id))));};
 const prune=()=>{const remaining=queue.filter(item=>!stale(item));if(remaining.length<queue.length)emit('speech_discarded',{reason:'queue_expired'});queue=remaining;};
 function pump(){
  if(pumping||closed)return;
  pumping=(async()=>{
   while(queue.length&&!closed){
    prune();if(!queue.length)break;
    if(!queue[0].preview&&now()<nextSpeechAt)break;
    const item=queue.shift();if(stale(item)){emit('speech_discarded');continue;}
    const epoch=generation,controller=new AbortController();let played=false;active={...item,controller};
    try{
     lastCode='';const segments=[item.text];emit('speech_started',{segments:1});
     for(const text of segments){
      if(closed||controller.signal.aborted||epoch!==generation||stale(item))break;
      phase='synthesizing';publish();const audio=await synthesize(text,config.role,controller.signal,config.source);
      if(controller.signal.aborted||epoch!==generation||stale(item))break;
      phase='playing';played=true;publish();const started=now();await play(audio,controller.signal);emit('speech_segment_done',{elapsedMs:now()-started});
      await pause(speechPause(text),controller.signal);
     }
     emit(controller.signal.aborted||epoch!==generation||stale(item)?'speech_discarded':'speech_completed');
    }catch(error){
     if(controller.signal.aborted){emit('speech_cancelled');}
     else{lastCode=['speech_login_required','speech_key_required','speech_rate_limited','speech_audio_invalid','speech_playback_failed'].includes(error.code)?error.code:'speech_provider_unavailable';phase='unavailable';cooldownUntil=now()+15000;queue=[];emit('speech_failed',{code:lastCode});}
    }finally{if(played)nextSpeechAt=now()+minIntervalMs;active=null;if(phase!=='unavailable')phase='idle';publish();}
   }
  })().finally(()=>{pumping=null;});
 }
 function enqueue(item){
  if(closed||(!item.preview&&(!config.enabled||item.topic==='chat'&&!config.chat))||!item.text?.trim()||item.scope!==currentKey())return false;
  item={...item,text:briefSpeech(item.text),expiresAt:Math.min(item.expiresAt,now()+20000)};
  if(!item.text){emit('speech_discarded',{reason:'text_too_long'});return false;}
  if(item.preview&&(active?.preview||queue.some(entry=>entry.preview)))return false;
  if(item.topic==='advice'&&((active&&!active.controller.signal.aborted)||queue.length||now()<nextSpeechAt)){emit('speech_discarded',{reason:'output_backpressure'});return false;}
  const normalized=item.text.replace(/\s+/g,'').slice(0,6000),signature=createHash('sha256').update(item.scope+normalized).digest('hex');
  const prior=recent.get(signature);if(!item.preview&&prior!==undefined&&now()-prior<(item.priority>=2?15000:60000))return false;
  if(!item.preview&&now()<cooldownUntil)return false;
  recent.set(signature,now());if(recent.size>128)recent.delete(recent.keys().next().value);
  if(queue.length)emit('speech_queue_trimmed');
  queue=[item]; // At most one pending manual answer; newest replaces older.
  emit('speech_queued');publish();pump();return true;
 }
 const api={status:state,role:()=>config.role,
  async configure(next){
   const task=writes.catch(()=>{}).then(async()=>{
    if(closed)throw failure('speech_closed',409);
    if(Object.keys(next).some(k=>!['enabled','chat','role','source'].includes(k))||next.enabled!==undefined&&typeof next.enabled!=='boolean'||next.chat!==undefined&&typeof next.chat!=='boolean'||next.role!==undefined&&!roles.some(r=>r.id===next.role)||next.source!==undefined&&!['official','byok'].includes(next.source))throw failure('speech_invalid',400);
    const value={...config,...next};await writeFile(path+'.tmp',JSON.stringify(value),{mode:0o600});await rename(path+'.tmp',path);
    const reset=value.role!==config.role||value.source!==config.source||!value.enabled;
    if(reset)stop();else if(!value.chat){queue=queue.filter(item=>item.topic!=='chat');if(active?.topic==='chat')active.controller.abort();}
    config=value;lastCode='';if(!active)phase='idle';cooldownUntil=0;publish();return state();
   });writes=task;return task;
  },
  tick(){
   if(closed)return;const v=view(),key=currentKey();
   if(scope!==key){stop();scope=key;seen.clear();recent.clear();cooldownUntil=0;}
   if(active&&stale(active)){active.controller.abort();}
   prune();
   for(const item of (v.playback??[]).slice(-40)){
    if(!item||typeof item.id!=='string'||seen.has(item.id))continue;
    seen.set(item.id,now());if(seen.size>256)seen.delete(seen.keys().next().value);
    if(!Number.isFinite(item.at)||now()-item.at>30000||item.at>now()+500)continue;
    enqueue({...item,topic:'advice',scope:key,expiresAt:Math.min(item.expiresAt??now()+45000,item.at+90000)});
   }
   publish();pump();
  },
  chat({game,match,text}){syncScope();return enqueue({id:randomUUID(),scope:game+':'+match,text,topic:'chat',priority:2,expiresAt:now()+90000});},
  preview(){syncScope();const ok=enqueue({id:randomUUID(),scope:currentKey(),topic:'preview',text:roleById(config.role).intro,priority:2,expiresAt:now()+30000,preview:true});return {queued:ok};},
  canAutoRequest(){return !closed&&!active&&!pumping&&!queue.length&&(!config.enabled||now()>=nextSpeechAt);},
  async settle(){await pumping;await statusWrite;},
  async close(){if(closed)return;closed=true;stop();await Promise.allSettled([pumping,writes,statusWrite]);phase='stopped';publish();await statusWrite;},
 };
 function syncScope(){const key=currentKey();if(scope!==key){stop();scope=key;seen.clear();recent.clear();cooldownUntil=0;}}
 publish();await statusWrite;return api;
}
