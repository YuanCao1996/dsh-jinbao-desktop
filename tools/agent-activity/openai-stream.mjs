// Aggregate native DSH messages while publishing only explicit assistant text.
// Tool arguments must be complete before the native Agent may execute them.
export async function readChatCompletion(response,{onText=()=>{},maxBytes=512*1024}={}){
 const reader=response.body?.getReader();if(!reader)throw Error('Model response has no body');
 const decoder=new TextDecoder();let bytes=0,pending='',result,finished=false,done=false;
 const streaming=/text\/event-stream/i.test(response.headers.get('content-type')??'');
 let message={role:'assistant',content:'',reasoning_content:''},finishReason=null,usage;
 const calls=new Map();
 function packet(value){
  if(value==='[DONE]'){done=true;return;}
  if(done)throw Error('Unexpected data after stream end');
  const data=JSON.parse(value);if(data.error)throw Error('Model stream failed');if(data.usage)usage=data.usage;
  const choice=data.choices?.find(c=>c.index===0||c.index===undefined);if(!choice)return;
  const delta=choice.delta??{};
  if(finished&&(delta.content||delta.tool_calls?.length))throw Error('Unexpected model delta');
  if(typeof delta.content==='string'){message.content+=delta.content;onText(delta.content);}
  if(typeof delta.reasoning_content==='string')message.reasoning_content+=delta.reasoning_content;
  for(const call of delta.tool_calls??[]){
   if(!Number.isSafeInteger(call.index)||call.index<0||call.index>31)throw Error('Invalid tool index');
   const current=calls.get(call.index)??{id:'',type:'function',function:{name:'',arguments:''}};
   if(call.id)current.id+=call.id;
   if(typeof call.function?.name==='string')current.function.name+=call.function.name;
   if(typeof call.function?.arguments==='string')current.function.arguments+=call.function.arguments;
   calls.set(call.index,current);
  }
  if(choice.finish_reason!=null){finishReason=choice.finish_reason;finished=true;}
 }
 function frame(value){const data=value.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).replace(/^ /,'')).join('\n');if(data)packet(data);}
 try{
  while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>maxBytes)throw Error('Model response exceeds limit');pending+=decoder.decode(next.value,{stream:true});
   if(streaming){pending=pending.replace(/\r\n/g,'\n');let end;while((end=pending.indexOf('\n\n'))>=0){frame(pending.slice(0,end));pending=pending.slice(end+2);}}
  }
  pending+=decoder.decode();
  if(!streaming){result=JSON.parse(pending);return result;}
  if(pending.trim())frame(pending.replace(/\r\n/g,'\n'));
  if(!finished||!['stop','tool_calls'].includes(finishReason))throw Error('Model stream did not finish');
  if(calls.size){message.tool_calls=[...calls.entries()].sort(([a],[b])=>a-b).map(([,v])=>v);for(const call of message.tool_calls){if(!call.id||!call.function.name)throw Error('Incomplete tool call');const args=JSON.parse(call.function.arguments);if(!args||typeof args!=='object'||Array.isArray(args))throw Error('Invalid tool arguments');}}
  if(finishReason==='tool_calls'&&!calls.size)throw Error('Missing tool calls');
  return{choices:[{index:0,message,finish_reason:finishReason}],...(usage?{usage}:{})};
 }catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
}
