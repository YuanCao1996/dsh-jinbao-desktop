import {appendFile,mkdir}from'node:fs/promises';import{join}from'node:path';import{randomUUID,createHash}from'node:crypto';
import{createWindowObserver}from'../game-observation/windows.mjs';import{createAdaptiveScheduler}from'../game-observation/adaptive.mjs';
import{visualSignature,significantChange}from'../game-observation/visual-change.mjs';
import{createGenericIdentity}from'./generic-identity.mjs';
export function createDesktopObservation({stateDir,view,observer=createWindowObserver({enabled:true}),now=Date.now,trace=()=>{},publish=event=>appendFile(join(stateDir,'logs/generic.jsonl'),JSON.stringify(event)+'\n',{mode:0o600})}){
 let session=null,busy=false,frame=null,signature=null,revision=0,scheduler=null,closed=false,writes=Promise.resolve(),controlGeneration=0,pendingSelection=null;
 const identity=createGenericIdentity({now}),issued=new Map(),used=new Set();let lastFeedbackAt=-Infinity;
 const emit=rows=>{const task=writes.catch(()=>{}).then(async()=>{for(const row of rows)await publish(row);});writes=task;return task;};
 const specialized=()=>{const v=view();return ['lol','wzry'].includes(v.game)&&!v.ended&&v.match&&now()-v.updatedAt<30000;};
 const event=(kind,extra={})=>({game:'generic',match:session.match,t:now(),kind,...extra});
 const report=(action,reason,extra={})=>{try{trace({game:'generic',match:session?.match,action,reason,...extra});}catch{}};
 const rejected=reason=>{report('identity_rejected',reason);return {accepted:false,reason};};
 const state=()=>{const evidence=identity.snapshot();return {windowTitle:session.target.title,sourceKind:'window',identity:evidence.confirmed.game_name?'corroborated':Object.keys(evidence.tentative).length?'tentative':'unconfirmed',gameName:evidence.confirmed.game_name?.value,gameMode:evidence.confirmed.game_mode?.value,gameVersion:evidence.confirmed.game_version?.value,gamePhase:evidence.confirmed.game_phase?.value,identityEvidence:evidence,roundState:session.roundState,observationRevision:revision};};
 const phase=()=>session.roundState==='playing'?'InProgress':'Observing';
 async function stop(invalidate=true){if(invalidate)controlGeneration++;pendingSelection?.abort.abort();const end=session?event('event',{name:'GameEnd'}):null;session?.abort.abort();session=null;frame=null;issued.clear();used.clear();lastFeedbackAt=-Infinity;identity.clear();observer.clear();if(end)await emit([end]);}
 async function rotate(reason,roundState){const end=event('event',{name:'GameEnd',reason});const target=session.target;session.abort.abort();session={target,match:'generic-'+randomUUID(),roundState,abort:new AbortController()};frame=null;signature=null;issued.clear();used.clear();lastFeedbackAt=-Infinity;revision++;scheduler=createAdaptiveScheduler({now});report('round_changed',reason);await emit([end,event('game_start',{phase:phase(),genericState:state(),reason})]);}
 return{list:()=>observer.list(),status:()=>({enabled:!!session,targetId:session?.target.id,windowTitle:session?.target.title,match:session?.match,roundState:session?.roundState,identity:identity.snapshot(),scheduler:scheduler?.status()}),
  async start({targetId,authorized}){if(closed||authorized!==true||specialized())throw Object.assign(Error('Window unavailable'),{status:409});const expected=++controlGeneration;await stop(false);if(closed||expected!==controlGeneration)throw Object.assign(Error('Observation cancelled'),{status:409});const selection={abort:new AbortController(),promise:null};selection.promise=Promise.resolve().then(()=>observer.select({id:targetId,authorized:true,signal:selection.abort.signal}));pendingSelection=selection;let target;try{target=await selection.promise;}finally{if(pendingSelection===selection)pendingSelection=null;}if(closed||expected!==controlGeneration||specialized())throw Object.assign(Error('Observation cancelled'),{status:409});session={target,match:'generic-'+randomUUID(),roundState:'watching',abort:new AbortController()};signature=null;revision=0;scheduler=createAdaptiveScheduler({now});await mkdir(join(stateDir,'logs'),{recursive:true});await emit([event('game_start',{phase:'Observing',genericState:state()})]);return this.status();},
  async stop(){await stop();return{enabled:false};},
  plan(value){if(!session)throw Error('No selected window');return scheduler.propose(value);},
  async feedback(value){
   if(closed||!session||value?.game!=='generic'||value.match!==session.match)return rejected('session_changed');
   const receipt=issued.get(value.captured_at_ms),key=value.captured_at_ms+':'+value.source_sha256;
   if(!receipt||receipt!==value.source_sha256||!Number.isFinite(value.captured_at_ms)||now()-value.captured_at_ms>30000||value.captured_at_ms>now()+500)return rejected('frame_not_issued_or_stale');
   if(used.has(key))return rejected('duplicate_frame');if(value.captured_at_ms<lastFeedbackAt)return rejected('reordered_frame');lastFeedbackAt=value.captured_at_ms;used.add(key);if(used.size>16)used.delete(used.values().next().value);
   const observed=identity.observe(value.identity,key);revision++;
   report('identity_updated',undefined,{confirmedCount:Object.keys(observed.confirmed).length,candidateCount:Object.keys(observed.tentative).length});
   if(observed.changedGame){await rotate('game_changed','watching');return {accepted:true,rotated:true};}
   const gamePhase=observed.confirmed.game_phase?.value;
   if(gamePhase==='results'&&session.roundState==='playing'){identity.clearRound();await rotate('round_end','between');return {accepted:true,rotated:true};}
   if(gamePhase==='playing'&&session.roundState!=='playing'){await rotate('round_start','playing');return {accepted:true,rotated:true};}
   await emit([event('state',{phase:phase(),state:{genericState:state()}})]);return {accepted:true,rotated:false};
  },
  async confirm(value){if(closed||!session)throw Object.assign(Error('No selected window'),{status:409});const observed=identity.confirm(value);revision++;if(observed.changedGame)await rotate('user_identity','watching');else await emit([event('state',{phase:phase(),state:{genericState:state()}})]);return this.status();},
  async newRound(){if(closed||!session)throw Object.assign(Error('No selected window'),{status:409});identity.clearRound();await rotate('user_new_round','playing');return this.status();},
  async tick(){
   if(closed||!session||busy)return;busy=true;const owner=session;
   try{
    if(specialized()){await stop();return;}
    const windows=await observer.list({signal:owner.abort.signal}),current=windows.find(w=>w.id===owner.target.id);if(session!==owner||closed)return;if(!current){await stop();return;}
    const admission=scheduler.admit({active:current.foreground});if(!admission.allowed)return;
    const result=await observer.capture(admission.request,{signal:owner.abort.signal});if(session!==owner||closed)return;
    const next=visualSignature(result.image),changed=!signature||significantChange(signature,next);signature=next;scheduler.complete({changed,ok:true});if(changed)revision++;
    const image=result.png;if(image.length<=1048576)frame={game:'generic',match:owner.match,captured_at_ms:result.frame.captured_at_ms,image_base64:image.toString('base64'),media_type:'image/png'};
    await emit([event('state',{phase:phase(),state:{genericState:{...state(),capturedAt:now(),changed,quality:admission.request.quality}}})]);
   }catch{if(session===owner){scheduler?.complete({ok:false});frame=null;}}finally{busy=false;}
  },async capture({game,match}){if(game!=='generic'||!session||session.match!==match)return null;await this.tick();if(!session||session.match!==match||!frame||now()-frame.captured_at_ms>=10000)return null;const sha=createHash('sha256').update(Buffer.from(frame.image_base64,'base64')).digest('hex');issued.set(frame.captured_at_ms,sha);if(issued.size>8)issued.delete(issued.keys().next().value);return {...frame,source_sha256:sha};},
  async close(){closed=true;const pending=pendingSelection?.promise;await stop();await Promise.allSettled([pending,writes]);}};
}
