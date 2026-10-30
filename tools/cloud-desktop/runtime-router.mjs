// One native Agent turn at a time. Manual chat precedes queued background work.
import {randomUUID} from 'node:crypto';
export function createRuntimeRouter({getMode,factories,isCurrent=()=>true,maxQueue=4,onEvent=()=>{}}){
 let active=null,instance=null,opening=null,mode='',generation=0,closed=false,draining=false,retiring=false,retirement=Promise.resolve();const queue=[],retiringInstances=new Set();
 const failure=(message,code)=>Object.assign(Error(message),{status:409,...(code?{code}:{})});
 const manual=request=>request.priority==='manual'||request.topic==='chat';
 const emit=(task,event,extra={})=>{try{onEvent({game:task.request.game,match:task.request.match,topic:task.request.topic,requestId:task.request.activityId,event,...extra});}catch{}};
 function retire(previous,reason){
  if(!previous)return Promise.resolve();
  retiring=true;retiringInstances.add(previous);
  const closing=Promise.resolve().then(()=>previous.close(reason?{reason}:undefined)).finally(()=>retiringInstances.delete(previous));
  const fence=Promise.allSettled([retirement,closing]).then(()=>{if(retirement===fence)retiring=false;});retirement=fence;
  return closing;
 }
 async function reset(){
  generation++;const previous=instance,pending=opening;instance=null;mode='';
  for(const task of queue.splice(0)){emit(task,'task_cancelled');task.reject(failure('调用方式已切换，请重试'));}
  const closing=retire(previous);for(const runtime of retiringInstances)runtime.abortRetirement?.();
  const outcomes=await Promise.allSettled([closing,pending?.promise,retirement]);
  if(outcomes[0].status==='rejected')throw outcomes[0].reason;
  if(pending?.disposeFailed&&outcomes[1].status==='rejected')throw outcomes[1].reason;
 }
 async function drain(){
  if(draining||closed)return;draining=true;
  try{while(queue.length&&!closed){
   queue.sort((a,b)=>(manual(a.request)?0:1)-(manual(b.request)?0:1));const task=queue.shift();
   if(!isCurrent(task.request.game,task.request.match)){emit(task,'task_stale');task.reject(failure('对局已切换'));continue;}
   const epoch=generation;active=task;
   try{
    if(retiring)emit(task,'task_waiting_handoff');
    await retirement;if(epoch!==generation||closed)throw failure('调用方式已切换');
    emit(task,'task_started');
    const next=await getMode();if(epoch!==generation||closed)throw failure('调用方式已切换');if(next==='demo'||!factories[next])throw failure('当前未启用模型服务');
    if(!instance||mode!==next){
     const previous=instance;instance=null;mode='';await retire(previous);if(epoch!==generation||closed)throw failure('调用方式已切换');
     const pending={promise:null,disposeFailed:false};
     pending.promise=(async()=>{const created=await factories[next]();if(epoch!==generation||closed){try{await created.close();}catch(error){pending.disposeFailed=true;throw error;}throw failure('调用方式已切换');}instance=created;mode=next;})();
     opening=pending;try{await pending.promise;}finally{if(opening===pending)opening=null;}
    }
    if(epoch!==generation||closed||!instance)throw failure('调用方式已切换');
    const result=await instance.ask(task.request);
    if(epoch!==generation||!isCurrent(task.request.game,task.request.match))throw failure('调用方式或对局已切换');emit(task,'task_completed');task.resolve(result);
   }catch(error){emit(task,epoch!==generation||task.interrupted?'task_cancelled':!isCurrent(task.request.game,task.request.match)?'task_stale':'task_failed',{code:task.interrupted?'agent_preempted':error.code,httpStatus:error.status});task.reject(task.interrupted?failure('已优先处理手动请求','agent_preempted'):error);}finally{active=null;}
  }}finally{draining=false;}
 }
 return{busy:()=>!!active||draining,async reconfigure(){await reset();},
  ask(request){
   if(closed)return Promise.reject(failure('请求较多，请稍后重试'));
   if(queue.length>=maxQueue){
    const index=manual(request)?queue.findLastIndex(task=>!manual(task.request)):-1;
    if(index<0)return Promise.reject(failure('请求较多，请稍后重试'));
    const [displaced]=queue.splice(index,1);emit(displaced,'task_cancelled');displaced.reject(failure('已优先处理手动请求','agent_preempted'));
   }
   if(manual(request)&&active&&!manual(active.request)){active.interrupted=true;const previous=instance;generation++;instance=null;mode='';void retire(previous,'preempt').catch(()=>{});}
   return new Promise((resolve,reject)=>{const task={request:{...request,activityId:randomUUID()},resolve,reject};queue.push(task);emit(task,'task_queued');void drain();});
  },async close(){closed=true;await reset();}};
}
