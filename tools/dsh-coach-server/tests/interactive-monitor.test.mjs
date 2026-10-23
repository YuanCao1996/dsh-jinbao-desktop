import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createMonitor} from '../lib/index.js';

for(const failureKind of ['compaction','oversize'])test('monitor preserves full replies and recovers context once: '+failureKind,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jinbao-monitor-'));let sessions=0,sends=0,emptyRejected=false;const prompts=[];
 const workspace={sessionIds:[],attachSession(id){this.sessionIds.push(id);}};
 const ctx={on:()=>()=>{},get:key=>key==='workspaceRegistry'?{resolveByPath:async()=>workspace}:undefined,
 agentLoop:{createAgent:async(_ctx,options)=>{
  sessions++;const listeners=new Map(),tools=new Map();const agentCtx={get:()=>undefined,on:(name,fn)=>listeners.set(name,fn),tools:{register:tool=>tools.set(tool.name,tool)}};
  await options.setup(agentCtx);const agent={status:'idle',session:{id:options.sessionId},send(message){
   sends++;prompts.push(message.content[0].text);agent.status='running';
   setTimeout(async()=>{
    if(sends===1){listeners.get('session/event')?.(agent.session,failureKind==='compaction'?{type:'compaction/end',data:{error:'summary failed'}}:{type:'turn/end',data:{reason:{kind:'error',error:{code:'INVALID_REQUEST',message:'413 request body too large'}}}});}
    else{try{await tools.get('coach_reply').execute({text:''});}catch{emptyRejected=true;}
     await tools.get('coach_reply').execute({text:'完整回答'.repeat(1500)});}
    agent.status='idle';
   },5);
  },cancel(){this.status='idle';}};
  return {agent,dispose:async()=>{}};
 }}};
 const monitor=createMonitor(ctx,{sessionCwd:root,diagLogFile:join(root,'diagnostic.log'),liveStateFile:join(root,'state.json'),monitorSessionId:'self-test',monitorMatch:'one',defaultGame:'lol',coachPreset:'test',monitorStartTimeoutMs:2000,liveTimeoutMs:2000},()=>({persona:{}}));t.after(()=>monitor.close());
 const answer=await monitor.submitInteraction({kind:'chat'},'one',{chat:true,question:'详细说明',game:'lol',match_id:'one'});
 assert.equal(sessions,2);assert.equal(sends,2);assert.equal(emptyRejected,true);assert.equal(answer,'完整回答'.repeat(1500));assert.match(prompts[0],/用户主动提问/);assert.match(prompts[1],/详细说明/);
});

test('chat accepts completed native final text after tools, ignores reasoning and never reuses it for the next silent turn',async t=>{
 const root=await mkdtemp(join(tmpdir(),'jinbao-chat-final-'));let count=0;
 const ctx={on:()=>()=>{},get:key=>key==='workspaceRegistry'?{resolveByPath:async()=>({sessionIds:[],attachSession(){}})}:undefined,agentLoop:{createAgent:async(_ctx,options)=>{
  const listeners=new Map();await options.setup({get:()=>undefined,on:(name,fn)=>listeners.set(name,fn),tools:{register(){}}});
  const agent={status:'idle',session:{id:options.sessionId},send(){agent.status='running';const n=++count;setTimeout(()=>{
   const emit=(type,data)=>listeners.get('session/event')?.(agent.session,{type,data});
   if(n===1){
    emit('step/start',{});emit('assistant/message',{message:{content:[{type:'text',text:'Searching...'}]}});emit('tool/call',{});
    emit('step/start',{});emit('assistant/message',{message:{content:[{type:'reasoning',text:'private reasoning'},{type:'text',text:'完整的最终回答'.repeat(300)}]}});
   }
   emit('turn/end',{reason:{kind:'completed'}});agent.status='idle';
  },5);},cancel(){this.status='idle';}};return {agent,dispose:async()=>{}};
 }}};
 const monitor=createMonitor(ctx,{sessionCwd:root,diagLogFile:join(root,'diag.log'),liveStateFile:join(root,'state.json'),monitorSessionId:'final-test',monitorMatch:'one',defaultGame:'lol',coachPreset:'test',liveTimeoutMs:2000},()=>({persona:{}}));t.after(()=>monitor.close());
 const submit=()=>monitor.submitInteraction({kind:'chat'},'one',{chat:true,question:'hi',game:'lol',match_id:'one'});
 assert.equal(await submit(),'完整的最终回答'.repeat(300));assert.equal(await submit(),'');
});
