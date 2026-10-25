import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {serviceUrl,limitedJson} from '../dsh-game-services/client.mjs';
const fail=(status,message)=>Object.assign(Error(message),{status});
export function cloudContext(memory,game,match,{eventQuery=false,observationPlan=false}={}){
 const c=memory.current;
 if(c&&(c.game!==game||c.match!==match))throw fail(409,'Match changed');
 const player=p=>p?Object.fromEntries(['champion','level','gold','dead','hpPct','k','d','a','items','spells'].filter(k=>p[k]!==undefined).map(k=>[k,Array.isArray(p[k])?p[k].slice(0,8):p[k]])):undefined;
 const value={current_match_state:{game_id:game,status:c?'observed':'unknown',revision:c?.at??0,captured_at_ms:c?.at??Date.now(),
  game_seconds:c?.gameSeconds,mode:c?.mode,phase:c?.phase,me:player(c?.me),allies:c?.allies?.slice(0,5).map(player),enemies:c?.enemies?.slice(0,5).map(player),
  generic_state:game==='generic'?c?.me?.genericState:undefined,
  team_score:Number.isInteger(c?.me?.teamKills)&&Number.isInteger(c?.me?.enemyKills)?{ally:c.me.teamKills,enemy:c.me.enemyKills}:undefined,
  bench:c?.phase==='ChampSelect'?c?.bench?.slice(0,20):undefined,
  offers:c?.offers?.slice(0,6),owned_augments:c?.ownedAugments?.slice(0,12)},
  events:(c?.events??[]).slice(-20).map(e=>({time:e.time,text:String(e.text??'').slice(0,240)})),client_context:{game_id:game,mode:c?.mode??'',capabilities:{event_query_v1:eventQuery,observation_plan_v1:game==='generic'&&observationPlan},user_memory:{confirmed_preferences:(memory.preferences??[]).slice(-6)}}};
 if(Buffer.byteLength(JSON.stringify(value))>24000)throw fail(413,'Current facts exceed the bounded context budget');
 return value;
}
export function createCloudAgent({getToken,getContext,isCurrent=()=>true,onProgress=()=>{},capture,queryEvents,observationPlan,
 serviceBaseUrl='https://api.jinbaoai.top',apiPrefix='/desktop/agent',deviceId='default',fetchImpl=fetch,pollMs=800,timeoutMs=90000}){
 if(!['/desktop/agent','/desktop/agent-preview'].includes(apiPrefix))throw Error('Invalid Agent route');
 const service=serviceUrl(serviceBaseUrl);const lifetime=new AbortController();let busy=false,settled=Promise.resolve(),finish=()=>{};
 async function call(path,token,data,signal,key){
  const response=await fetchImpl(new URL(apiPrefix+path,service),{method:data===undefined?'GET':'POST',redirect:'error',signal,
   headers:{Authorization:'Bearer '+token,...(data===undefined?{}:{'Content-Type':'application/json'}),...(key?{'Idempotency-Key':key}:{})},...(data===undefined?{}:{body:JSON.stringify(data)})});
  if(!response.ok){const retryAfterMs=Math.min(30000,Math.max(1000,Number(response.headers.get('retry-after'))*1000||5000));await response.body?.cancel();throw Object.assign(fail(response.status,'Cloud Agent request failed'),{retryAfterMs});}
  return limitedJson(response,256*1024);
 }
 return {async ask(request){
  if(busy)throw fail(409,'Cloud Agent is busy');busy=true;
  settled=new Promise(resolve=>{finish=resolve;});
  let task,token,terminal=false;const signal=AbortSignal.any([lifetime.signal,AbortSignal.timeout(timeoutMs)]);
  const current=()=>isCurrent(request.game,request.match);
  try{
   token=await getToken();if(!token)throw fail(401,'Login required');if(!current())throw fail(409,'Match changed');
   const session='desktop-'+createHash('sha256').update(JSON.stringify([deviceId,request.game,request.match])).digest('hex');
   const context=cloudContext(await getContext(request.game,request.match),request.game,request.match,{eventQuery:!!queryEvents,observationPlan:!!observationPlan});
   const message=request.topic==='equipment'?'根据本局装备、全部已选海克斯与对手威胁，推荐下一件具体装备并解释理由。':request.question;
   const key=randomUUID();let created;
   for(let attempt=0;attempt<2;attempt++){
    try{created=await call('/tasks',token,{session_id:session,message,context},signal,key);break;}
    catch(error){if(error.status||signal.aborted||attempt)throw error;}
   }
   if(!/^[a-f0-9-]{32,36}$/.test(created.task_id??''))throw fail(502,'Invalid task');task=created.task_id;
   let cursor=0,revision=context.current_match_state.revision,nextContextAt=0;const handled=new Set();
   while(true){
    signal.throwIfAborted();if(!current())throw fail(409,'Match changed');
    let update;
    try{update=await call('/tasks/'+task+'?after='+cursor,token,undefined,signal);}
    catch(error){if(error.status!==429)throw error;onProgress({game:request.game,match:request.match,event:'rate_limited'});await sleep(error.retryAfterMs,undefined,{signal});continue;}
    if(!Number.isSafeInteger(update.cursor)||update.cursor<cursor)throw fail(502,'Invalid cursor');cursor=update.cursor;
    const terminalUpdate=['completed','failed','cancelled'].includes(update.status);
    for(const event of update.events??[]){
     onProgress({game:request.game,match:request.match,...event});
     if(!terminalUpdate&&event.event==='observation_plan_requested'&&!handled.has(event.request_id)){
      if(!/^[a-f0-9]{32}$/.test(event.request_id??''))throw fail(502,'Invalid plan request');handled.add(event.request_id);let status='unavailable';
      try{if(request.game==='generic'&&observationPlan&&current()){await observationPlan(event.plan);status='applied';}}catch{}
      if(!current())throw fail(409,'Match changed');await call('/tasks/'+task+'/plan-results',token,{request_id:event.request_id,status},signal);
     }
     if(!terminalUpdate&&event.event==='events_requested'&&!handled.has(event.request_id)){
      if(!/^[a-f0-9]{32}$/.test(event.request_id??''))throw fail(502,'Invalid event request');
      handled.add(event.request_id);let result={status:'unavailable',reason:'event_query_unavailable'};
      try{if(queryEvents)result=await queryEvents({game:request.game,match:request.match,args:event.query});}catch{}
      if(!current())throw fail(409,'Match changed');
      if(!result||typeof result!=='object'||Buffer.byteLength(JSON.stringify(result))>14000)result={status:'unavailable',reason:'event_query_unavailable'};
      await call('/tasks/'+task+'/event-results',token,{request_id:event.request_id,...result},signal);
     }
     if(!terminalUpdate&&event.event==='screen_requested'&&!handled.has(event.request_id)){
      handled.add(event.request_id);let frame;
      try{frame=await capture?.({game:request.game,match:request.match});}catch{}
      if(!current())throw fail(409,'Match changed');
      const fresh=frame?.captured_at_ms&&Date.now()-frame.captured_at_ms<=30000&&frame.game===request.game&&frame.match===request.match;
      await call('/tasks/'+task+'/attachments',token,fresh?{request_id:event.request_id,captured_at_ms:frame.captured_at_ms,image_base64:frame.image_base64}:{request_id:event.request_id,status:'unavailable',reason:'screen_unavailable'},signal);
     }
    }
    if(update.status==='completed'){terminal=true;if(typeof update.reply!=='string'||!update.reply.trim())throw fail(502,'Empty reply');return update.reply;}
    if(['failed','cancelled'].includes(update.status)){terminal=true;throw fail(503,'Cloud Agent task failed');}
    const latest=cloudContext(await getContext(request.game,request.match),request.game,request.match,{eventQuery:!!queryEvents,observationPlan:!!observationPlan});
    if(latest.current_match_state.revision>revision&&Date.now()>=nextContextAt){
     try{await call('/context',token,{session_id:session,context:latest},signal);revision=latest.current_match_state.revision;nextContextAt=Date.now()+2000;}
     catch(error){if(error.status!==429)throw error;nextContextAt=Date.now()+error.retryAfterMs;onProgress({game:request.game,match:request.match,event:'rate_limited'});}
    }
    await sleep(pollMs,undefined,{signal});
   }
  }finally{
   if(task&&!terminal&&token)await call('/tasks/'+task+'/cancel',token,{},AbortSignal.timeout(5000)).catch(()=>{});
   busy=false;finish();
  }
 },busy:()=>busy,async close(){lifetime.abort();await settled;}};
}
