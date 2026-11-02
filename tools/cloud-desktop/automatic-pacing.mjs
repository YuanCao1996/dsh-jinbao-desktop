export const isAutomatic=request=>request.automatic===true||(request.priority!=='manual'&&['advice','equipment'].includes(request.topic));
// One shared admission gate for coach and background builds; never queue here.
//
// The interval is tracked per topic. A single shared window let the far more frequent
// background build starve the battle advice: every automatic run closed the gate for
// a whole interval, so in a live match "advice" almost never got a turn (observed:
// 20 output_backpressure skips in 12 minutes, advicePublished 0).
const topicOf=request=>{const value=request?.topic;return typeof value==='string'&&value?value:'advice';};
export function createAutomaticPacing({now=Date.now,busy=()=>false,intervalMs=60000,onSkip=()=>{}}={}){
 let active=false;
 const nextAt=new Map();
 // Coarse gate for pre-flight checks: the coach asks this before building context.
 // Whether this particular topic may run is decided in run(), the real admission point.
 // `urgent` covers the moments the player explicitly asked for guidance (a confirmed
// augment): waiting for a quiet voice queue starved them (9 of ~24 confirmations produced
// advice in a four-match log), so an urgent request may pass a busy queue while still
// waiting for the in-flight turn and the per-topic window.
const allowed=request=>!active&&(request?.urgent===true||!busy());
 const openFor=request=>now()>=(nextAt.get(topicOf(request))??-Infinity);
 const status=()=>({active,nextAt:[...nextAt.values()].reduce((max,value)=>Math.max(max,value),-Infinity),intervalMs,topics:Object.fromEntries(nextAt)});
 return {canRequest:()=>allowed(),status,
  async run(request,execute){
   if(!isAutomatic(request))return execute(request);
   const topic=topicOf(request);
   if(!allowed(request)||!openFor(request)){
    try{onSkip(request);}catch{}
    throw Object.assign(Error('Automatic analysis deferred'),{code:'auto_deferred',status:409,retryAt:Math.max(now()+3000,nextAt.get(topic)??-Infinity)});
   }
   active=true;
   try{return await execute({...request,automatic:true});}
   finally{active=false;nextAt.set(topic,now()+intervalMs);}
  }};
}
