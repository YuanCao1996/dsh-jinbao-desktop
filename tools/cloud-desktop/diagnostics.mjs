import {mkdir,readdir,stat,open,readFile,writeFile,appendFile,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';

// Separate from game memory: no prompts, tool arguments, answers or image pixels.
const events=new Set(['run_start','run_end','snapshot','bookmark','agent','coach','capture','speech','observation','cache','usage','anomaly']);
const kinds=new Set(['battle','chat','augments','overlay','shortcuts','other']);
const strings={
 game:new Set(['lol','wzry','generic']),topic:new Set(['advice','equipment','chat']),
 phase:new Set(['None','Lobby','Matchmaking','ReadyCheck','ChampSelect','Loading','GameStart','InProgress','EndOfGame','CapturePaused','WaitingForStats','PreEndOfGame']),
 state:new Set(['healthy','unresponsive','starting','launch_failed','recovery_limited','external','running','published','stale','failed','interrupted','idle','ended','synthesizing','playing','unavailable','stopped']),
 reason:new Set(['session_changed','frame_not_issued_or_stale','duplicate_frame','reordered_frame','game_changed','round_end','round_start','user_new_round','user_identity','queue_expired','output_backpressure','text_too_long','busy','disabled','no_live_match','retry_backoff','context_changed','source_stale','no_trigger','reply_discarded','match_changed','scoreboard_visible','capture_stale','duplicate_capture','capture_failed','capture_host_unavailable','capture_host_unresponsive','screen_render_empty','window_render_empty','not_foreground','ocr_unavailable','no_window','other']),
 action:new Set(['identity_updated','identity_rejected','round_changed','task_queued','task_started','task_waiting_handoff','task_completed','task_failed','task_cancelled','task_stale','tool_start','tool_end','connection_retry','connection_restored','rate_limited','screen_requested','events_requested','memory_requested','observation_plan_requested','completed','coach_running','coach_published','coach_failed','coach_stale','coach_interrupted','skip','reply_discarded','speech_queued','speech_started','speech_segment_done','speech_completed','speech_failed','speech_cancelled','speech_discarded','speech_queue_trimmed','cache_deleted','cache_cleanup_pending','cache_report_received','cache_report_pending','usage_report_received','usage_report_pending','other']),
 stage:new Set(['selection','loading','augment','postAugment','enemyChange','situation','early','ultimate','death','purchase']),
 name:new Set(['get_current_match_state','get_lineup_context','get_recent_match_events','query_match_events','query_current_match_events','search_local_knowledge','site_query','search_game_guides','web_search','web_fetch','inspect_latest_screen','get_user_memory','manage_user_memory','set_observation_plan']),
 code:new Set(['agent_preempted','agent_request_failed','model_quota_denied','model_transport_unavailable','model_transport_timeout','model_transport_http_error','advice_wait_long','agent_wait_long','overlay_heartbeat_stale','event_loop_delayed','speech_login_required','speech_key_required','speech_rate_limited','speech_audio_invalid','speech_playback_failed','speech_provider_unavailable']),
 role:new Set(['jinbao','liurufeng','wangbatian','tiezhi']),source:new Set(['official','byok']),
 focus:new Set(['full','titles']),captureBackend:new Set(['window-client','screen-fallback','print-window','screen']),
 displayMode:new Set(['large','narrow','silent']),page:new Set(['advice','equipment','augments','players','events','chat']),playbackPhase:new Set(['idle','playing','fade','linger']),
};
const numbers=new Set(['elapsedMs','ageMs','ioFailures','recognized','knownSlots','sequence','captureMs','ocrMs','totalMs','gameSeconds','adviceCount','chatCount','offerCount','ownedCount','retryAt','httpStatus','width','height','opacity','queueSize','shortcutId','registeredCount','failedCount','segments','confirmedCount','candidateCount']);
const booleans=new Set(['available','foreground','panelOccluded','ended','success','fresh','healthy','collapsed','subtitle','visible','playbackActive']);
const runName=/^\d{4}-\d{2}-\d{2}T[\dTZ-]+-[a-f0-9]{8}$/;
function fields(value={}) {
 const out={};
 for(const [key,allowed] of Object.entries(strings))if(value[key]!==undefined)out[key]=allowed.has(value[key])?value[key]:'other';
 for(const key of numbers)if(Number.isFinite(value[key]))out[key]=Math.max(0,Math.min(1e15,value[key]));
 for(const key of booleans)if(typeof value[key]==='boolean')out[key]=value[key];
 if(kinds.has(value.kind))out.kind=value.kind;
 return out;
}

export async function createDiagnostics({stateDir,view=()=>({}),now=Date.now,expectOverlay=true,maxFileBytes=512*1024,maxFiles=4,maxRuns=10}={}) {
 const runId=new Date(now()).toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8);
 const base=join(stateDir,'diagnostics'),directory=join(base,runId),salt=randomUUID();
 try{await mkdir(directory,{recursive:true});}catch{return {record(){},accept(){},coach(){},tick:async()=>{},close:async()=>{},status:()=>({recording:false,supported:true,writeErrors:1}),mark(){throw Object.assign(Error('Diagnostics unavailable'),{status:503});},export:async()=>({summary:{recording:false,writeErrors:1},events:[]})};}
 const folders=(await readdir(base,{withFileTypes:true})).filter(e=>e.isDirectory()&&runName.test(e.name)).map(e=>e.name).sort().reverse();
 for(const name of folders.slice(maxRuns))if(name!==runId)await rm(join(base,name),{recursive:true,force:true}).catch(()=>{});
 let closed=false,pending=0,chain=Promise.resolve(),index=0,size=0,ticking=false,lastTick=now(),lastBeat=0,scope='',lastSnapshot='',lastCapture='',lastAdviceAt=now();
 const counters={events:0,dropped:0,writeErrors:0,bookmarks:0,taskFailures:0,advicePublished:0},tasks=new Map(),dedup=new Map(),alerts=new Set();
 const hash=value=>createHash('sha256').update(salt+String(value).slice(0,256)).digest('hex').slice(0,20);
 const summary=()=>({schema:1,supported:true,runId,startedAt,startTime:new Date(startedAt).toISOString(),at:now(),recording:!closed,...counters,activeTasks:tasks.size,alerts:[...alerts]});
 const startedAt=now();
 function record(event,value={}) {
  if(closed||!events.has(event))return;
  const clean=fields(value),signature=event+JSON.stringify(clean);
  // State-only skip events are sampled; task events must keep their ordering.
  if(event==='coach'&&clean.action==='skip'){
   if(now()-(dedup.get(signature)??-Infinity)<30000)return;
   dedup.set(signature,now());if(dedup.size>64)dedup.delete(dedup.keys().next().value);
  }
  if(pending>=256){counters.dropped++;return;}
  const at=now(),entry={schema:1,at,event,...clean};
  if(value.match)entry.matchId=hash(value.game+':'+value.match);
  if(value.requestId)entry.requestId=hash(value.requestId);
  if(event==='bookmark')counters.bookmarks++;
  if(event==='agent'&&value.action==='task_started')tasks.set(entry.requestId,{at,topic:clean.topic});
  if(event==='agent'&&['task_completed','task_failed','task_cancelled','task_stale'].includes(value.action)){
   const task=tasks.get(entry.requestId);if(task)entry.elapsedMs=at-task.at;
   tasks.delete(entry.requestId);if(value.action==='task_failed')counters.taskFailures++;
  }
  if(event==='coach'&&value.action==='coach_published'){lastAdviceAt=at;counters.advicePublished++;}
  if(tasks.size>32)tasks.delete(tasks.keys().next().value);
  const line=JSON.stringify(entry)+'\n';pending++;
  chain=chain.catch(()=>{}).then(async()=>{
   try{
    if(size+Buffer.byteLength(line)>maxFileBytes){index++;size=0;if(index>=maxFiles)await rm(join(directory,`events-${index-maxFiles}.jsonl`),{force:true});}
    await appendFile(join(directory,`events-${index}.jsonl`),line,{mode:0o600});size+=Buffer.byteLength(line);counters.events++;
   }catch{counters.writeErrors++;}finally{pending--;}
  });
 }
 async function json(name) {
  let file;try{file=await open(join(stateDir,name),'r');const info=await file.stat();if(info.size>16384)return null;return JSON.parse(await file.readFile('utf8'));}catch{return null;}finally{await file?.close();}
 }
 async function save(){try{await writeFile(join(directory,'status.json.tmp'),JSON.stringify(summary()),{mode:0o600});await rename(join(directory,'status.json.tmp'),join(directory,'status.json'));}catch{counters.writeErrors++;}}
 function alert(code,active,context){if(active&&!alerts.has(code)){alerts.add(code);record('anomaly',{...context,code});}else if(!active)alerts.delete(code);}
 const api={record,status:summary,
  accept(event){if(!strings.action.has(event?.event))return;record('agent',{...event,action:event.event,elapsedMs:event.elapsed_ms,httpStatus:event.httpStatus??event.status});},
  coach(event){record('coach',event);},
  mark(kind){if(!kinds.has(kind))throw Object.assign(Error('Invalid issue kind'),{status:400});record('bookmark',{...view(),kind});return {marked:true,at:now(),runId};},
  async tick(){
   if(closed||ticking)return;ticking=true;
   try{
    const at=now(),v=view(),context={game:v.game,match:v.match,phase:v.phase};
    alert('event_loop_delayed',at-lastTick>7000,context);lastTick=at;
    const fresh=Number.isFinite(v.updatedAt)&&at-v.updatedAt>=-500&&at-v.updatedAt<30000;
    const key=v.game+':'+v.match;
    if(key!==scope){scope=key;lastAdviceAt=at;alerts.delete('advice_wait_long');}
    const sample={...context,fresh,ended:v.ended===true,adviceCount:Array.isArray(v.playback)?v.playback.length:0,chatCount:Array.isArray(v.chatRows)?v.chatRows.length:0,ageMs:Number.isFinite(v.updatedAt)?at-v.updatedAt:undefined};
    // Age is bucketed so unchanged idle states do not generate 2-second spam.
    if(sample.ageMs!==undefined)sample.ageMs=Math.floor(sample.ageMs/10000)*10000;
    const signature=JSON.stringify(fields(sample))+hash(key);
    if(signature!==lastSnapshot||at-lastBeat>=30000){record('snapshot',sample);lastSnapshot=signature;lastBeat=at;}
    const [host,health,capture,hotkeys]=await Promise.all([json('overlay-capture-host.json'),json('overlay-health.json'),json('augment-diagnostics.json'),json('overlay-hotkeys.json')]);
    alert('overlay_heartbeat_stale',expectOverlay&&at-startedAt>20000&&(!host||!Number.isFinite(host.at)||at-host.at>10000||host.at>at+500),context);
    if(health)recordChangedHealth(health,context);
    if(capture&&Number.isFinite(capture.at)&&at-capture.at<30000){
     const value={...context,...fields(capture)},sig=JSON.stringify(value);
     if(sig!==lastCapture||at-lastCaptureBeat>30000){record('capture',value);lastCapture=sig;lastCaptureBeat=at;}
    }
    if(host&&host.ioFailures!==lastIoFailures){record('snapshot',{...context,ioFailures:host.ioFailures});lastIoFailures=host.ioFailures;}
    if(host){const data=fields(host),key=JSON.stringify(data);if(key!==lastWindow){record('snapshot',{...context,...data});lastWindow=key;}}
    if(hotkeys){const data={registeredCount:(hotkeys.bindings??[]).filter(b=>b.registered===true).length,failedCount:(hotkeys.bindings??[]).filter(b=>b.registered===false).length,shortcutId:hotkeys.lastReceived?.id};const key=JSON.stringify(data)+String(hotkeys.lastReceived?.at);if(key!==lastHotkeys){record('snapshot',{...context,...data});lastHotkeys=key;}}
    alert('advice_wait_long',fresh&&v.phase==='InProgress'&&!v.ended&&at-lastAdviceAt>120000,context);
    alert('agent_wait_long',[...tasks.values()].some(t=>at-t.at>90000),context);
    await chain;await save();
   }catch{counters.writeErrors++;}finally{ticking=false;}
  },
  async export(){
   await chain;const previousRuns=[];
   const older=(await readdir(base,{withFileTypes:true})).filter(e=>e.isDirectory()&&e.name!==runId&&runName.test(e.name)).map(e=>e.name).sort().reverse().slice(0,2);
   for(const id of older){try{const data=await readRun(join(base,id));previousRuns.push({runId:id,events:data});}catch{}}
   return {summary:summary(),privacy:{prompts:false,replies:false,players:false,credentials:false,screenshots:false},events:await readRun(directory),previousRuns};
  },
  async close(){if(closed)return;record('run_end');closed=true;await chain;while(ticking)await new Promise(r=>setTimeout(r,10));await save();},
 };
 let lastHealth='',lastIoFailures=-1,lastCaptureBeat=0,lastWindow='',lastHotkeys='';
 async function readRun(dir){
  const rows=[],files=(await readdir(dir)).filter(n=>/^events-\d+\.jsonl$/.test(n)).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0])).slice(-maxFiles);
  for(const name of files){if((await stat(join(dir,name))).size>maxFileBytes+8192)continue;for(const line of (await readFile(join(dir,name),'utf8')).split('\n'))try{const row=JSON.parse(line);if(events.has(row.event)&&Number.isFinite(row.at)){const clean={schema:1,at:row.at,event:row.event,...fields(row)};for(const k of ['matchId','requestId'])if(/^[a-f0-9]{20}$/.test(row[k]??''))clean[k]=row[k];rows.push(clean);}}catch{}}
  return rows;
 }
 function recordChangedHealth(health,context){if(health.state===lastHealth)return;lastHealth=health.state;record('snapshot',{...context,state:health.state});}
 record('run_start');await chain;await save();return api;
}
