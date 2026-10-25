import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createLocalAgent} from '../local-agent.mjs';
test('installed DSH native sessions execute a real tool turn, resume and isolate matches',{skip:!process.env.JINBAO_TEST_DSH_MODULES,timeout:30000},async()=>{
 const stateDir=await mkdtemp(join(tmpdir(),'jinbao-native-'));let match='one',calls=0;const requests=[];
 const options={stateDir,moduleRoot:process.env.JINBAO_TEST_DSH_MODULES,getConfig:async()=>({baseUrl:'https://model.example/v1',model:'fixture'}),getKey:async()=>'test-only-key',isCurrent:(_game,m)=>m===match,getContext:async()=>({current:{game:'lol',match,at:Date.now(),mode:'KIWI',me:{champion:'安妮'}}}),queryEvents:async()=>({status:'ok',rows:[{text:'购买残疫'}]}),fetchImpl:async(_url,options)=>{const body=JSON.parse(options.body);requests.push(body);calls++;return Response.json({choices:[calls===1?{finish_reason:'tool_calls',message:{content:null,reasoning_content:'fixture-reasoning',tool_calls:[{id:'read-current',type:'function',function:{name:'get_current_match_state',arguments:'{}'}}]}}:{finish_reason:'stop',message:{content:'先等控制技能，再接爆发。'}}]});}};
 let agent;try{
  agent=await createLocalAgent(options);assert.match(await agent.ask({game:'lol',match,question:'现在怎么打？'}),/控制技能/);assert.equal(calls,2);assert.ok(requests[1].messages.some(m=>m.role==='tool'&&m.tool_call_id==='read-current'));assert.equal(requests[1].messages.find(m=>m.role==='assistant').reasoning_content,'fixture-reasoning');assert.match(JSON.stringify(requests[0]),/海克斯大乱斗/);
  await agent.close();agent=await createLocalAgent(options);await agent.ask({game:'lol',match,question:'本局继续'});assert.ok(JSON.stringify(requests.at(-1)).includes('现在怎么打'));
  match='two';await agent.ask({game:'lol',match,question:'新局开始'});assert.ok(!JSON.stringify(requests.at(-1)).includes('本局继续'));
 }finally{await agent?.close();await rm(stateDir,{recursive:true,force:true});}
});
test('native long-match history compacts while current facts remain queryable',{skip:!process.env.JINBAO_TEST_DSH_MODULES,timeout:30000},async()=>{
 const stateDir=await mkdtemp(join(tmpdir(),'jinbao-native-long-'));let compactions=0,maxBytes=0,agent;
 try{agent=await createLocalAgent({stateDir,moduleRoot:process.env.JINBAO_TEST_DSH_MODULES,getConfig:async()=>({baseUrl:'https://model.example/v1',model:'fixture'}),getKey:async()=>'fixture',getContext:async()=>({current:{game:'lol',match:'long',mode:'KIWI',at:Date.now(),me:{champion:'安妮',gold:1234}}}),queryEvents:async()=>({status:'ok',rows:[]}),fetchImpl:async(_url,options)=>{const body=JSON.parse(options.body);maxBytes=Math.max(maxBytes,Buffer.byteLength(options.body));const compact=!body.tools?.length;if(compact)compactions++;return Response.json({choices:[{finish_reason:'stop',message:{content:compact?'用户明确偏好 ALPHA；当前事实仍须通过本局工具读取。':'建议'.repeat(2500)}}]});}});
 for(let i=0;i<24;i++)await agent.ask({game:'lol',match:'long',topic:'chat',question:i===0?'记住本局偏好 ALPHA':'继续分析第'+i+'轮'});
 assert.ok(compactions>0,'native compaction was exercised');assert.ok(maxBytes<180000,'history remained bounded instead of growing to megabytes');
 }finally{await agent?.close();await rm(stateDir,{recursive:true,force:true});}
});
