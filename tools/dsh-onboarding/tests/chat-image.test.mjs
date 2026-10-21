import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeChatImage,inspectChatImage} from '../chat-image.mjs';
import {buildGameChatMessage} from '../../dsh-coach-server/lib/chat-bridge.js';

const jpeg=Buffer.concat([Buffer.from([0xff,0xd8,0xff]),Buffer.alloc(130,7)]).toString('base64');

test('a user image is bounded, inspected as observation, and kept separate from confirmed match facts',async()=>{
  assert.equal(decodeChatImage(jpeg).length,133);
  assert.throws(()=>decodeChatImage(Buffer.alloc(200,7).toString('base64')),e=>e.status===400);
  let inspected=false;
  const result=await inspectChatImage({image:jpeg,question:'这是什么海克斯？',origin:'http://127.0.0.1:3084',token:'local-only',fetchImpl:async(url,request)=>{
    inspected=true;
    assert.equal(url,'http://127.0.0.1:3084/v1/chat/completions');
    assert.equal(request.headers.Authorization,'Bearer local-only');
    const payload=JSON.parse(request.body);
    assert.match(payload.messages[1].content[1].image_url.url,/^data:image\/jpeg;base64,/);
    return {ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'{"observations":"可见三个候选","uncertain":[]}'}}]})};
  }});
  assert.equal(inspected,true);
  assert.equal(result.status,'observed');
  assert.match(buildGameChatMessage('怎么选？',{current:{game:'lol'}},'lol',result),/用户附图的视觉观察/);
  assert.match(buildGameChatMessage('怎么选？',{current:{game:'lol'}},'lol',result),/不代表当前实时对局/);
});

test('vision failure is reported without inventing a visible image',async()=>{
  const result=await inspectChatImage({image:jpeg,question:'看看图片',origin:'http://127.0.0.1:3084',token:'local-only',fetchImpl:async()=>({ok:false,body:{cancel:async()=>{}}})});
  assert.equal(result.status,'unavailable');
  assert.match(result.note,/未能读取附图/);
});
