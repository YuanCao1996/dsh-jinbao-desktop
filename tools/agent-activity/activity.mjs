import {mkdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';

const tools={get_current_match_state:'读取当前对局',get_lineup_context:'读取双方阵容',get_recent_match_events:'读取关键事件',query_match_events:'检索本局日志',query_current_match_events:'检索本局日志',search_local_knowledge:'检索游戏资料',site_query:'检索游戏资料',search_game_guides:'搜索游戏攻略',web_search:'搜索游戏攻略',web_fetch:'读取攻略正文',inspect_latest_screen:'观察游戏画面',get_user_memory:'读取游戏偏好',manage_user_memory:'管理明确偏好',set_observation_plan:'调整画面观察'};
const topics={chat:'聊天',equipment:'出装分析',advice:'自动教练'};
const clock=value=>Number.isFinite(value)?String(Math.floor(value/60)).padStart(2,'0')+':'+String(Math.floor(value%60)).padStart(2,'0'):'等待对局';
const safeId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(value);
export function sanitizeActivityText(value,sensitive=[]){
 let text=String(value??'').slice(0,6000).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'');
 text=text.replace(/(?:https?:\/\/|(?:[a-zA-Z]:[\\/])|(?:\/(?:home|Users|var|etc|opt|tmp)\/))[^\s，。！？；<>]*/g,'[地址已隐藏]')
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[邮箱已隐藏]')
  .replace(/\b(?:sk[-_]|j[cdwp]_)[a-zA-Z0-9_-]+/g,'[凭据已隐藏]')
  .replace(/\b(?:bearer\s+|(?:api[_ -]?key|authorization|token|secret|password)\s*[:=]\s*)[^\s，。；]+/gi,'[凭据已隐藏]')
  .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g,'[地址已隐藏]');
 for(const name of [...new Set(sensitive)].filter(v=>typeof v==='string'&&v.length>=2).sort((a,b)=>b.length-a.length))text=text.split(name).join('[玩家已隐藏]');
 return text.length>900?'…'+text.slice(-899):text;
}

export async function createAgentActivity({stateDir,getView=()=>null,now=Date.now}={}){
 const instanceId=randomUUID();
 const path=join(stateDir,'agent-activity-settings.json');let enabled=false,revision=0,scope='',rows=[],tasks=new Map(),writes=Promise.resolve(),closed=false;
 try{const bytes=await readFile(path);if(bytes.length<=1024)enabled=JSON.parse(bytes).enabled===true;}catch{}
 function row(id,task,label,phase,extra={}){
  let entry=rows.find(value=>value.id===id);
  if(entry){const updates={label,phase,...extra};if(Object.entries(updates).every(([key,value])=>entry[key]===value))return;Object.assign(entry,updates);}
  else{entry={id,task:task.id,topic:topics[task.topic]??'智能体',clock:task.clock,label,phase,...extra};rows.push(entry);}
  rows=rows.slice(-40);revision++;
 }
 const allowed=request=>{const view=getView();return !view||((view.game||'lol')===request.game&&(view.match||'waiting')===request.match);};
 const api={
  isEnabled:()=>enabled&&!closed,
  status:()=>({supported:true,enabled}),
  async setEnabled(value){
   if(typeof value!=='boolean')throw Object.assign(Error('Invalid activity setting'),{status:400});
   const task=writes.catch(()=>{}).then(async()=>{
    await mkdir(stateDir,{recursive:true});const temporary=path+'.'+randomUUID()+'.tmp';
    try{await writeFile(temporary,JSON.stringify({enabled:value}),{mode:0o600});for(let attempt=0;;attempt++){try{await rename(temporary,path);break;}catch(error){if(attempt>=4||!['EPERM','EACCES','EBUSY'].includes(error.code))throw error;await sleep(20*(attempt+1));}}}finally{await unlink(temporary).catch(()=>{});}
    enabled=value;rows=[];tasks.clear();scope='';revision++;
   });writes=task;await task;return api.status();
  },
  accept(event){
   if(!enabled||closed||!event||!safeId(event.requestId)||!['lol','wzry','generic'].includes(event.game)||typeof event.match!=='string'||!allowed(event))return;
   const key=event.game+':'+event.match;if(scope!==key){scope=key;rows=[];tasks.clear();revision++;}
   let task=tasks.get(event.requestId);
   // Only the local router may open a display task. A delayed remote event
   // cannot recreate a terminal task after its bounded cache entry was evicted.
   if(!task){if(!['task_queued','task_started'].includes(event.event))return;const view=getView();task={id:event.requestId,topic:event.topic,clock:view?.gameTime??clock(view?.gameSeconds),at:now(),draft:'',seq:{},tools:0};tasks.set(task.id,task);if(tasks.size>8){const oldest=tasks.keys().next().value;tasks.delete(oldest);rows=rows.filter(entry=>entry.task!==oldest);revision++;}}
   if(task.terminal)return;
   const current=getView();task.clock=current?.gameTime??clock(current?.gameSeconds);
   if(Number.isSafeInteger(event.seq)){
    const channel=event.channel??'control';if(event.seq<=(task.seq[channel]??0))return;task.seq[channel]=event.seq;
   }
   const type=event.event,id=task.id;
   if(type==='task_queued')row(id,task,'等待执行','queued');
   else if(type==='task_waiting_handoff')row(id,task,'等待上一任务退出，随后处理','queued');
   else if(type==='task_started')row(id,task,'正在分析本局','running');
   else if(type==='cancellation_wait')row(id,task,'正在停止旧任务，优先处理手动请求','queued');
   else if(type==='tool_start'){
    const index=Number.isSafeInteger(event.index)?event.index:++task.tools;task.lastTool=index;
    row(id+':tool:'+index,task,tools[event.name]??'执行游戏工具','running');
   }else if(type==='tool_end'){
    const index=Number.isSafeInteger(event.index)?event.index:task.lastTool;
    if(index!=null)row(id+':tool:'+index,task,tools[event.name]??'执行游戏工具',event.success===false?'unavailable':'done',{elapsedMs:Number.isFinite(event.elapsed_ms)?Math.max(0,Math.min(300000,event.elapsed_ms)):null});
   }else if(type==='web_search_result'){
    const empty=['no_usable_results','rss_no_usable_results'].includes(event.reason);
    const label=event.status==='ok'?'已找到匹配的游戏资料':empty?'未找到匹配模式的攻略':event.reason==='rate_limited'?'攻略搜索服务暂时限流':'攻略搜索暂时不可用';
    row(id+':search-summary',task,label,event.status==='ok'?'done':'unavailable');
   }else if(type==='model_start')row(id+':model:'+Number(event.request_index??0),task,'模型正在分析','running');
   else if(type==='model_end')row(id+':model:'+Number(event.request_index??0),task,event.status>=400?'模型请求失败':'本步模型分析结束',event.status>=400?'failed':'done',{elapsedMs:Number.isFinite(event.elapsed_ms)?Math.max(0,Math.min(300000,event.elapsed_ms)):null});
   else if(type==='compaction')row(id+':compact',task,'整理本局上下文','running');
   else if(type==='rate_limited')row(id+':wait',task,'请求受限，等待恢复','queued');
   else if(type==='connection_retry')row(id+':connection',task,'连接中断，正在重试','queued');
   else if(type==='connection_restored')row(id+':connection',task,'连接已恢复，继续接收','done');
   else if(type==='public_text'&&typeof event.text==='string'){
    // Only explicit assistant text is accepted. Raw reasoning/tool arguments
    // never enter this store. Hold unfinished clauses before redaction/display.
    task.draft=((event.reset?'':task.draft)+event.text.slice(0,3600)).slice(0,3600);
    const end=Math.max(task.draft.lastIndexOf('。'),task.draft.lastIndexOf('！'),task.draft.lastIndexOf('？'),task.draft.lastIndexOf('\n'));
    if(end>=0)row(id+':draft',task,'公开回答草稿 · 尚未完成校验','draft',{text:task.draft.slice(0,end+1)});
    else if(event.reset){const length=rows.length;rows=rows.filter(entry=>entry.id!==id+':draft');if(rows.length!==length)revision++;}
   }else if(['task_completed','task_failed','task_cancelled','task_stale'].includes(type)){
    task.terminal=true;task.draft='';rows=rows.filter(entry=>entry.id!==id+':draft');
    for(const entry of rows)if(entry.task===id&&['running','queued'].includes(entry.phase))entry.phase=type==='task_completed'?'done':'cancelled';
    row(id,task,({task_completed:'本次分析完成',task_failed:'分析失败，可稍后重试',task_cancelled:'任务已中断',task_stale:'对局已变化，取消旧任务'})[type],type==='task_completed'?'done':type==='task_failed'?'failed':'cancelled');
   }
  },
  snapshot(state){
   if(!enabled)return{supported:true,enabled:false,instanceId,revision,rows:[]};
   const currentScope=(state.game||'lol')+':'+(state.match||'waiting');
   if(scope&&scope!==currentScope){scope=currentScope;rows=[];tasks.clear();revision++;}
   const sensitive=[state.me,...(state.allies??[]),...(state.enemies??[])].filter(Boolean).flatMap(p=>['name','player','riotId','summonerName','puuid'].map(k=>p[k]));
   return{supported:true,enabled:true,instanceId,revision,rows:rows.map(entry=>({...entry,...(entry.text?{text:sanitizeActivityText(entry.text,sensitive)}:{})}))};
  },
  async close(){closed=true;rows=[];tasks.clear();await writes;}
 };return api;
}
