// One native Agent turn at a time. Manual chat precedes queued background work.
export function createRuntimeRouter({getMode,factories,isCurrent=()=>true,maxQueue=4}){
 let active=null,instance=null,mode='',generation=0,closed=false,draining=false;const queue=[];
 const failure=message=>Object.assign(Error(message),{status:409});
 async function reset(){generation++;const previous=instance;instance=null;mode='';for(const task of queue.splice(0))task.reject(failure('调用方式已切换，请重试'));await previous?.close();}
 async function drain(){
  if(draining||closed)return;draining=true;
  try{while(queue.length&&!closed){
   queue.sort((a,b)=>(a.request.topic==='chat'?0:1)-(b.request.topic==='chat'?0:1));const task=queue.shift();
   if(!isCurrent(task.request.game,task.request.match)){task.reject(failure('对局已切换'));continue;}
   const epoch=generation;active=task;
   try{
    const next=await getMode();if(next==='demo'||!factories[next])throw failure('当前未启用模型服务');
    if(!instance||mode!==next){await instance?.close();const created=await factories[next]();if(epoch!==generation||closed){await created.close();throw failure('调用方式已切换');}instance=created;mode=next;}
    const result=await instance.ask(task.request);
    if(epoch!==generation||!isCurrent(task.request.game,task.request.match))throw failure('调用方式或对局已切换');task.resolve(result);
   }catch(error){task.reject(error);}finally{active=null;}
  }}finally{draining=false;}
 }
 return{busy:()=>!!active||draining,async reconfigure(){await reset();},
  ask(request){
   if(closed||queue.length>=maxQueue)return Promise.reject(failure('请求较多，请稍后重试'));
   if(request.topic==='chat'&&active&&active.request.topic!=='chat'&&instance){const previous=instance;generation++;instance=null;mode='';void previous.close().catch(()=>{});}
   return new Promise((resolve,reject)=>{queue.push({request,resolve,reject});void drain();});
  },async close(){closed=true;await reset();}};
}
