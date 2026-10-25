// Reserve one lane for current augment choices, independent of slow hero reads.
export function createKnowledgeSearch(search,{now=Date.now,ttlMs=600000,spacingMs=120}={}){
 const cache=new Map(),pending=new Map(),queue=[];let blockedUntil=0,running=0,lowRunning=0,nextStart=0,timer,closed=false;
 const priority=q=>q.filter?._type==='augments'?(q.filter.name?0:1):2;
 function pump(){
  clearTimeout(timer);timer=null;
  if(closed)return;
  if(now()<blockedUntil){for(const item of queue.splice(0)){pending.delete(item.key);item.reject(Object.assign(Error('Knowledge search backoff'),{status:429}));}return;}
  queue.sort((a,b)=>a.priority-b.priority);
  while(running<2&&queue.length){
   const index=queue.findIndex(item=>item.priority<2||lowRunning===0);if(index<0)return;
   if(nextStart>now()){timer=setTimeout(pump,nextStart-now());return;}
   const item=queue.splice(index,1)[0];running++;if(item.priority>=2)lowRunning++;nextStart=now()+spacingMs;
   Promise.resolve().then(()=>search(item.query)).then(value=>{
    if(value?.results?.length){cache.set(item.key,{at:now(),value:structuredClone(value)});if(cache.size>512)cache.delete(cache.keys().next().value);}item.resolve(value);
   },error=>{if(error.status===429)blockedUntil=now()+60000;item.reject(error);}).finally(()=>{running--;if(item.priority>=2)lowRunning--;pending.delete(item.key);pump();});
  }
 }
 const run=query=>{
  if(closed)return Promise.reject(Object.assign(Error('Search closed'),{status:503}));
  const key=JSON.stringify(query),saved=cache.get(key);
  if(saved&&now()-saved.at<ttlMs)return Promise.resolve(structuredClone(saved.value));
  if(pending.has(key))return pending.get(key);
  const task=new Promise((resolve,reject)=>queue.push({key,query,priority:priority(query),resolve,reject}));pending.set(key,task);queueMicrotask(pump);return task;
 };
 run.clear=()=>cache.clear();run.close=()=>{closed=true;clearTimeout(timer);for(const item of queue.splice(0)){pending.delete(item.key);item.reject(Object.assign(Error('Search closed'),{status:503}));}};return run;
}
