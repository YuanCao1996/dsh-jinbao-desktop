import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudCapture} from '../capture.mjs';

test('cloud screenshot stays bound to the active match before and after capture', async()=>{
 let state={game:'lol',match:'one',updatedAt:9000};
 const frame={available:true,game:'lol',mediaType:'image/jpeg',capturedAt:9500,data:'fixture'};
 const capture=createCloudCapture({now:()=>10000,readState:()=>state,capture:async()=>frame});
 assert.deepEqual(await capture({game:'lol',match:'one'}),{game:'lol',match:'one',captured_at_ms:9500,image_base64:'fixture'});
 state={...state,match:'two'};
 assert.equal(await capture({game:'lol',match:'one'}),null);
 state={...state,match:'one'};
 const changed=createCloudCapture({now:()=>10000,readState:()=>state,capture:async()=>{state={...state,match:'two'};return frame;}});
 assert.equal(await changed({game:'lol',match:'one'}),null);
});

test('cloud screenshot rejects stale, future, missing timestamps and ended games',async()=>{
 const state={game:'lol',match:'one',updatedAt:99000};
 for(const capturedAt of [undefined,0,100001,NaN]){
  const capture=createCloudCapture({now:()=>100000,readState:()=>state,capture:async()=>({available:true,game:'lol',mediaType:'image/jpeg',capturedAt,data:'fixture'})});
  assert.equal(await capture({game:'lol',match:'one'}),null);
 }
 const capture=createCloudCapture({now:()=>100000,readState:()=>({...state,ended:true}),capture:async()=>{assert.fail('Ended game must not capture');}});
 assert.equal(await capture({game:'lol',match:'one'}),null);
});
