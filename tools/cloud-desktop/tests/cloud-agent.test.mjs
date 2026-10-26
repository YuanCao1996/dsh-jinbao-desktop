import test from'node:test';import assert from'node:assert/strict';
import{createCloudAgent,cloudContext}from'../cloud-agent.mjs';
const memory={current:{game:'lol',match:'one',at:1,mode:'KIWI',me:{champion:'安妮'},events:[{text:'已购买残疫'}]},preferences:[{fact:'喜欢前排'}]};
test('cloud preview requests opt-in activity and keeps public text out of context updates',async()=>{const events=[];let polls=0;const agent=createCloudAgent({getToken:async()=>'test-token',getContext:async()=>memory,getActivityEnabled:()=>true,onProgress:e=>events.push(e),pollMs:1,fetchImpl:async(url,o)=>{if(new URL(url).pathname.endsWith('/tasks')){const context=JSON.parse(o.body).context;assert.equal(context.client_context.capabilities.agent_activity_v1,true);assert.ok(!JSON.stringify(context).includes('公开草稿'));return Response.json({task_id:'a'.repeat(32)});}return Response.json({cursor:1,events:[],status:++polls===1?'running':'completed',reply:polls>1?'最终建议':null,activity:[{seq:1,event:'public_text',text:'公开草稿。',reset:true}]});}});try{assert.equal(await agent.ask({game:'lol',match:'one',activityId:'activity-test',topic:'advice',question:'怎么打'}),'最终建议');assert.equal(events[0].channel,'activity');assert.equal(events[0].requestId,'activity-test');}finally{await agent.close();}});
test('long Chinese memory and events reduce initial context without changing observed facts',()=>{
 const state={...memory,current:{...memory.current,events:Array.from({length:20},()=>({text:'前'.repeat(240)}))},preferences:Array.from({length:6},()=>({fact:'前'.repeat(500)}))};
 state.current.me={champion:'安妮',items:Array.from({length:8},()=>({name:'前'.repeat(60)}))};
 state.current.enemies=Array.from({length:5},()=>({...state.current.me}));
 const value=cloudContext(state,'lol','one');assert.ok(Buffer.byteLength(JSON.stringify(value))<=24000);assert.equal(value.client_context.context_reduced,true);assert.equal(value.current_match_state.captured_at_ms,1);assert.equal(value.current_match_state.me.champion,'安妮');
});
test('cloud task uses bounded current context, idempotency and tool progress without local DSH',async()=>{
 const calls=[],keys=[],progress=[];let attempt=0;
 const agent=createCloudAgent({getToken:async()=>'private-token',getContext:async()=>memory,pollMs:1,onProgress:e=>progress.push(e),fetchImpl:async(url,options)=>{
  const path=new URL(url).pathname;calls.push(path);assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer private-token');
  if(path.endsWith('/tasks')){keys.push(options.headers['Idempotency-Key']);const body=JSON.parse(options.body);assert.equal(body.context.client_context.game_id,'lol');assert.equal(body.context.conversation,undefined);assert.equal(body.context.current_match_state.me.champion,'安妮');if(++attempt===1)throw Error('network disconnected');return Response.json({task_id:'a'.repeat(32)});}
  return Response.json({status:'completed',cursor:1,events:[{event:'tool_end',name:'get_current_match_state'}],reply:'先等队友控制再进场'});
 }});
 assert.equal(await agent.ask({game:'lol',match:'one',question:'下一波怎么打'}),'先等队友控制再进场');assert.equal(keys[0],keys[1]);assert.equal(progress[0].name,'get_current_match_state');agent.close();
});
test('changing match cancels original task and never returns its answer',async()=>{
 let current=true,cancelled=false;
 const agent=createCloudAgent({getToken:async()=>'token',getContext:async()=>memory,isCurrent:()=>current,pollMs:1,fetchImpl:async(url)=>{
  const path=new URL(url).pathname;if(path.endsWith('/cancel')){cancelled=true;return Response.json({});}current=false;return Response.json({task_id:'a'.repeat(32)});
 }});
 await assert.rejects(agent.ask({game:'lol',match:'one',question:'hi'}),e=>e.status===409);assert.equal(cancelled,true);agent.close();
});
test('screen request sends explicit unavailable result instead of pretending to see the screen',async()=>{
 let polls=0,unavailable;
 const agent=createCloudAgent({getToken:async()=>'token',getContext:async()=>memory,pollMs:1,fetchImpl:async(url,options)=>{
  const path=new URL(url).pathname;if(path.endsWith('/tasks'))return Response.json({task_id:'a'.repeat(32)});
  if(path.endsWith('/attachments')){unavailable=JSON.parse(options.body);return Response.json({});}
  return ++polls===1?Response.json({status:'running',cursor:1,events:[{event:'screen_requested',request_id:'b'.repeat(32)}]}):Response.json({status:'completed',cursor:2,events:[],reply:'未获取到画面，根据日志判断'});
 }});
 await agent.ask({game:'lol',match:'one',question:'看下画面'});assert.equal(unavailable.status,'unavailable');agent.close();
});
test('context cannot substitute another match',()=>{assert.throws(()=>cloudContext(memory,'lol','two'),e=>e.status===409);});
test('terminal task updates never trigger expired log or screenshot uploads',async()=>{
 const agent=createCloudAgent({getToken:async()=>'token',getContext:async()=>memory,
  queryEvents:async()=>assert.fail('Must not read after completion'),capture:async()=>assert.fail('Must not capture after completion'),
  fetchImpl:async url=>new URL(url).pathname.endsWith('/tasks')?Response.json({task_id:'a'.repeat(32)}):Response.json({status:'completed',cursor:2,events:[{event:'events_requested',request_id:'b'.repeat(32),query:{}},{event:'screen_requested',request_id:'c'.repeat(32)}],reply:'任务已完成'})});
 assert.equal(await agent.ask({game:'lol',match:'one',question:'hi'}),'任务已完成');await agent.close();
});
test('event query is bound to the active match and repeated request events are handled once',async()=>{
 let polls=0,reads=0,uploads=0;
 const event={event:'events_requested',request_id:'b'.repeat(32),query:{kind:'purchase',cursor:0,limit:1}};
 const agent=createCloudAgent({getToken:async()=>'token',getContext:async()=>memory,pollMs:1,
  queryEvents:async request=>{reads++;assert.equal(request.game,'lol');assert.equal(request.match,'one');assert.equal(request.args.kind,'purchase');return {status:'ok',rows:[],next_cursor:null};},
  fetchImpl:async(url,options)=>{
   const path=new URL(url).pathname;if(path.endsWith('/tasks'))return Response.json({task_id:'a'.repeat(32)});
   if(path.endsWith('/event-results')){uploads++;assert.equal(JSON.parse(options.body).request_id,event.request_id);return Response.json({accepted:true});}
   return ++polls<3?Response.json({status:'running',cursor:polls,events:[event]}):Response.json({status:'completed',cursor:3,events:[],reply:'查完了'});
  }});
 assert.equal(await agent.ask({game:'lol',match:'one',question:'之前买了什么'}),'查完了');
 assert.equal(reads,1);assert.equal(uploads,1);await agent.close();
});
test('changing match during an event read cancels the task without uploading the old page',async()=>{
 let current=true,uploaded=false,cancelled=false;
 const agent=createCloudAgent({getToken:async()=>'token',getContext:async()=>memory,isCurrent:()=>current,
  queryEvents:async()=>{current=false;return{status:'ok',rows:[],next_cursor:null};},
  fetchImpl:async url=>{
   const path=new URL(url).pathname;if(path.endsWith('/tasks'))return Response.json({task_id:'a'.repeat(32)});
   if(path.endsWith('/cancel')){cancelled=true;return Response.json({});}
   if(path.endsWith('/event-results')){uploaded=true;return Response.json({});}
   return Response.json({status:'running',cursor:1,events:[{event:'events_requested',request_id:'b'.repeat(32),query:{}}]});
  }});
 await assert.rejects(agent.ask({game:'lol',match:'one',question:'之前买了什么'}),e=>e.status===409);
 assert.equal(uploaded,false);assert.equal(cancelled,true);await agent.close();
});
test('poll throttling backs off without creating or cancelling another task',async()=>{
 let creates=0,polls=0,cancelled=false;
 const agent=createCloudAgent({getToken:async()=>'token',getContext:async()=>memory,fetchImpl:async url=>{
  const path=new URL(url).pathname;
  if(path.endsWith('/tasks')){creates++;return Response.json({task_id:'a'.repeat(32)});}
  if(path.endsWith('/cancel')){cancelled=true;return Response.json({});}
  if(++polls===1)return Response.json({}, {status:429,headers:{'Retry-After':'1'}});
  return Response.json({status:'completed',cursor:1,events:[],reply:'任务仍然有效'});
 }});
 assert.equal(await agent.ask({game:'lol',match:'one',question:'hi'}),'任务仍然有效');
 assert.equal(creates,1);assert.equal(cancelled,false);await agent.close();
});
test('closing waits for the in-flight cloud task cancellation before allowing process exit',async()=>{
 let markPolling,cancelled=false;const polling=new Promise(resolve=>markPolling=resolve);
 const agent=createCloudAgent({getToken:async()=>'token',getContext:async()=>memory,fetchImpl:async(url,options)=>{
  const path=new URL(url).pathname;
  if(path.endsWith('/tasks'))return Response.json({task_id:'a'.repeat(32)});
  if(path.endsWith('/cancel')){await new Promise(resolve=>setTimeout(resolve,20));cancelled=true;return Response.json({});}
  markPolling();return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
 }});
 const task=agent.ask({game:'lol',match:'one',question:'hi'});const failed=assert.rejects(task);
 await polling;await agent.close();await failed;
 assert.equal(cancelled,true);assert.equal(agent.busy(),false);
});
