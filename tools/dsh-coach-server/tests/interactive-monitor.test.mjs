import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createMonitor} from '../lib/index.js';

test('real monitor queue calls native session, rejects silent chat, preserves full reply and recovers blocked context once',async t=>{
 const root=await mkdtemp(join(tmpdir(),'jinbao-monitor-'));let sessions=0,sends=0,emptyRejected=false;const prompts=[];
 const workspace={sessionIds:[],attachSession(id){this.sessionIds.push(id);}};
 const ctx={on:()=>()=>{},get:key=>key==='workspaceRegistry'?{resolveByPath:async()=>workspace}:undefined,
 agentLoop:{createAgent:async(_ctx,options)=>{
  sessions++;const listeners=new Map(),tools=new Map();const agentCtx={get:()=>undefined,on:(name,fn)=>listeners.set(name,fn),tools:{register:tool=>tools.set(tool.name,tool)}};
  await options.setup(agentCtx);const agent={status:'idle',session:{id:options.sessionId},send(message){
   sends++;prompts.push(message.content[0].text);agent.status='running';
   setTimeout(async()=>{
    if(sends===1){listeners.get('session/event')?.(agent.session,{type:'compaction/end',data:{error:'summary failed'}});}
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
