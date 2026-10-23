// Observe native DSH events; never replace its Agent, history or compaction engine.
export function createTurnHealth(){
 let compactionErrors=0,finalText='',completed=false;
 return {reset(){compactionErrors=0;finalText='';completed=false;},observe(event){
  if(event?.type==='compaction/end'&&event.data?.error)compactionErrors++;
  if(event?.type==='turn/end'){
   if(event.data?.reason?.error?.code==='CONTEXT_WINDOW_EXCEEDED')compactionErrors++;
   completed=event.data?.reason?.kind==='completed'&&!event.data?.reason?.error;
  }
  if(event?.type==='step/start')finalText='';
  if(event?.type==='tool/call')finalText='';
  if(event?.type==='assistant/message'){
   const blocks=event.data?.message?.content;
   finalText=Array.isArray(blocks)&&!blocks.some(b=>b?.type!=='text'&&b?.type!=='reasoning')
    ?blocks.filter(b=>b?.type==='text'&&typeof b.text==='string').map(b=>b.text).join('').trim():'';
  }
 },chatAnswer(){return completed&&!compactionErrors?finalText:'';},failedWithoutReply(text){return !text&&compactionErrors>0;}};
}
export function recoverySessionId(base,nonce){return base+'-recover-'+nonce;}
export function canRetryContext(job,error){return error?.code==='AGENT_CONTEXT_BLOCKED'&&!job.contextRetried;}
