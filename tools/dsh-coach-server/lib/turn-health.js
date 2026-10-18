// Observe native DSH events; never replace its Agent, history or compaction engine.
export function createTurnHealth(){
 let compactionErrors=0;
 return {reset(){compactionErrors=0;},observe(event){if(event?.type==='compaction/end'&&event.data?.error)compactionErrors++;if(event?.type==='turn/end'&&event.data?.reason?.error?.code==='CONTEXT_WINDOW_EXCEEDED')compactionErrors++;},failedWithoutReply(text){return !text&&compactionErrors>0;}};
}
export function recoverySessionId(base,nonce){return base+'-recover-'+nonce;}
export function canRetryContext(job,error){return error?.code==='AGENT_CONTEXT_BLOCKED'&&!job.contextRetried;}
