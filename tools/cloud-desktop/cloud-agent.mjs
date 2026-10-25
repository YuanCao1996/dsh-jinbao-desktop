import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {serviceUrl,limitedJson} from '../dsh-game-services/client.mjs';
import {equipmentContext} from '../dsh-onboarding/equipment-context.mjs';
const fail=(status,message)=>Object.assign(Error(message),{status});
export function agentQuestion(request){
 let message=request.question;
 if(request.topic==='equipment'&&typeof message==='string'&&message.includes('【装备决策事实 JSON】'))message=message.split('【装备决策事实 JSON】')[0].replace('只用 coach_reply 提交','直接提交')+'\n按需读取当前事实中的 equipment_decision；区分 confirmedAugments 与 assumedAugments，推测不当作已拥有。';
 if(typeof message!=='string'||!message.trim()||message.length>2000)throw fail(413,'Agent message exceeds the bounded task budget');
 return message;
}
export function cloudContext(memory,game,match,{eventQuery=false,observationPlan=false,userMemory=false}={}){
 const c=memory.current;
 if(c&&(c.game!==game||c.match!==match))throw fail(409,'Match changed');
 const compact=value=>typeof value==='string'?value.slice(0,120):value&&typeof value==='object'?Object.fromEntries(['name','id','count','level','ready','cooldown'].filter(k=>['string','number','boolean'].includes(typeof value[k])).map(k=>[k,typeof value[k]==='string'?value[k].slice(0,120):value[k]])):value;
 const player=p=>p?Object.fromEntries(['champion','level','gold','dead','hpPct','k','d','a','items','spells','canShop','respawn'].filter(k=>p[k]!==undefined).map(k=>[k,Array.isArray(p[k])?p[k].slice(0,8).map(compact):compact(p[k])])):undefined;
 const equipment=c&&game!=='generic'?equipmentContext({...c,me:c.me??{},enemies:c.enemies??[],ownedAugments:c.ownedAugments??[],augmentRounds:c.augmentRounds??[]}):undefined;
 const value={current_match_state:{game_id:game,status:c?'observed':'unknown',revision:c?.at??0,captured_at_ms:c?.at??Date.now(),
  game_seconds:c?.gameSeconds,mode:c?.mode,phase:c?.phase,me:player(c?.me),allies:c?.allies?.slice(0,5).map(player),enemies:c?.enemies?.slice(0,5).map(player),
  generic_state:game==='generic'?c?.me?.genericState:undefined,
  team_score:Number.isInteger(c?.me?.teamKills)&&Number.isInteger(c?.me?.enemyKills)?{ally:c.me.teamKills,enemy:c.me.enemyKills}:undefined,
  bench:c?.phase==='ChampSelect'?c?.bench?.slice(0,20):undefined,
  offers:c?.offers?.slice(0,6).map(compact),owned_augments:c?.ownedAugments?.slice(0,12).map(compact),
  equipment_decision:equipment?{...equipment,currentItems:equipment.currentItems.slice(0,8).map(compact),enemies:equipment.enemies.slice(0,5).map(e=>({hero:String(e.hero??'').slice(0,120),items:e.items.slice(0,8).map(compact)})),unassignedEnemyItems:equipment.unassignedEnemyItems.slice(0,8).map(compact),confirmedAugments:equipment.confirmedAugments.slice(0,12).map(compact),assumedAugments:equipment.assumedAugments.slice(0,6)}:undefined},
  events:(c?.events??[]).slice(-20).map(e=>({time:e.time,text:String(e.text??'').slice(0,240)})),client_context:{game_id:game,mode:c?.mode??'',capabilities:{event_query_v1:eventQuery,observation_plan_v1:game==='generic'&&observationPlan,user_memory_v1:userMemory},user_memory:{confirmed_preferences:(memory.preferences??[]).slice(-6)}}};
 const oversized=()=>Buffer.byteLength(JSON.stringify(value))>24000;
 while(oversized()&&value.events.length){value.events.shift();value.client_context.context_reduced=true;}
 while(oversized()&&value.client_context.user_memory.confirmed_preferences.length){value.client_context.user_memory.confirmed_preferences.shift();value.client_context.context_reduced=true;}
 if(oversized())throw fail(413,'Current facts exceed the bounded context budget');
 return value;
}
export function createCloudAgent({getToken,getContext,isCurrent=()=>true,onProgress=()=>{},capture,queryEvents,observationPlan,memoryTools,
 serviceBaseUrl='https://api.jinbaoai.top',apiPrefix='/desktop/agent',deviceId='default',fetchImpl=fetch,pollMs=800,timeoutMs=90000}){
 if(!['/desktop/agent','/desktop/agent-preview'].includes(apiPrefix))throw Error('Invalid Agent route');
 const service=serviceUrl(serviceBaseUrl);const lifetime=new AbortController();let busy=false,settled=Promise.resolve(),finish=()=>{},wireRevision=0,wireKey='',wireValue;
 function transportContext(memory,request){
  const value=cloudContext(memory,request.game,request.match,{eventQuery:!!queryEvents,observationPlan:!!observationPlan,userMemory:!!memoryTools});
  if(value.current_match_state.status==='unknown')delete value.current_match_state.captured_at_ms;
  const key=JSON.stringify(value);
  if(key!==wireKey){wireRevision=Math.max(Date.now(),wireRevision+1);value.current_match_state.source_revision=value.current_match_state.revision;value.current_match_state.revision=wireRevision;wireKey=key;wireValue=value;}
  return structuredClone(wireValue);
 }
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
   const context=transportContext(await getContext(request.game,request.match),request);
   const message=agentQuestion(request);
   const key=randomUUID();let created;
   for(let attempt=0;attempt<2;attempt++){
    try{created=await call('/tasks',token,{session_id:session,message,context},signal,key);break;}
    catch(error){if(error.status||signal.aborted||attempt)throw error;}
   }
   if(!/^[a-f0-9-]{32,36}$/.test(created.task_id??''))throw fail(502,'Invalid task');task=created.task_id;
   let cursor=0,revision=context.current_match_state.revision,nextContextAt=0,pollFailures=0;const handled=new Set();
   while(true){
    signal.throwIfAborted();if(!current())throw fail(409,'Match changed');
    let update;
    try{update=await call('/tasks/'+task+'?after='+cursor,token,undefined,signal);pollFailures=0;}
    catch(error){if(error.status===429){onProgress({game:request.game,match:request.match,event:'rate_limited'});await sleep(error.retryAfterMs,undefined,{signal});continue;}if(!signal.aborted&&(!error.status||[502,503,504].includes(error.status))&&pollFailures++<2){await sleep(250*pollFailures,undefined,{signal});continue;}throw error;}
    if(!Number.isSafeInteger(update.cursor)||update.cursor<cursor)throw fail(502,'Invalid cursor');cursor=update.cursor;
    const terminalUpdate=['completed','failed','cancelled'].includes(update.status);
    for(const event of update.events??[]){
     onProgress({game:request.game,match:request.match,...event});
     if(!terminalUpdate&&event.event==='memory_requested'&&!handled.has(event.request_id)){
      if(!/^[a-f0-9]{32}$/.test(event.request_id??''))throw fail(502,'Invalid memory request');handled.add(event.request_id);
      let result={status:'unavailable',reason:'memory_unavailable'};
      try{if(memoryTools&&current())result=await memoryTools({...request,args:event.args});}catch{}
      if(!current())throw fail(409,'Match changed');
      if(!result||typeof result!=='object'||Buffer.byteLength(JSON.stringify(result))>10000)result={status:'unavailable',reason:'memory_unavailable'};
      await call('/tasks/'+task+'/memory-results',token,{request_id:event.request_id,result},signal);
     }
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
    const latest=transportContext(await getContext(request.game,request.match),request);
    if(latest.current_match_state.revision>revision&&Date.now()>=nextContextAt){
     try{await call('/context',token,{session_id:session,context:latest},signal);revision=latest.current_match_state.revision;nextContextAt=Date.now()+2000;}
     catch(error){if(error.status!==429)throw error;nextContextAt=Date.now()+error.retryAfterMs;onProgress({game:request.game,match:request.match,event:'rate_limited'});}
    }
    await sleep(pollMs,undefined,{signal});
   }
  }catch(error){if(signal.aborted&&!lifetime.signal.aborted)throw fail(504,'Agent analysis timed out');throw error;}finally{
   if(task&&!terminal&&token)await call('/tasks/'+task+'/cancel',token,{},AbortSignal.timeout(5000)).catch(()=>{});
   busy=false;finish();
  }
 },busy:()=>busy,async close(){lifetime.abort();await settled;}};
}
