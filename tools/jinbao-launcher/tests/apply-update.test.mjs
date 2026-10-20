import test from 'node:test';
import assert from 'node:assert/strict';
import {waitAndApply} from '../apply-update.mjs';
const candidate={root:'/verified',release:{version:'2.0.0',sha256:'trusted'}};
test('prepared install waits for both launcher and host, revalidates files and launches once',async()=>{
 let time=0,parent=true,host=true,validated=0;const events=[],launched=[];
 const result=await waitAndApply({prepared:async()=>{validated++;return candidate;},parentRunning:async()=>parent,inspect:async()=>host,launch:async root=>launched.push(root),publish:async v=>events.push(v.state),cancelled:async()=>false,now:()=>time,wait:async()=>{time+=2000;if(time>=2000)parent=false;if(time>=4000)host=false;}});
 assert.equal(result,'launched');assert.equal(validated,2);assert.deepEqual(launched,['/verified']);assert.deepEqual(events,['waiting-host','applying']);assert.equal(time,4000);
});
test('cancel, timeout, and changed signed package never launch a new process',async()=>{
 for(const kind of ['cancel','timeout','tamper']){
  let time=0,count=0,launches=0;const states=[];
  const promise=waitAndApply({prepared:async()=>{count++;return kind==='tamper'&&count>1?null:candidate;},parentRunning:async()=>false,inspect:async()=>kind==='timeout',launch:async()=>{launches++;},publish:async v=>states.push(v.state),cancelled:async()=>kind==='cancel',now:()=>time,timeout:4000,wait:async()=>{time+=2000;}});
  if(kind==='tamper')await assert.rejects(promise);else assert.equal(await promise,kind==='cancel'?'cancelled':'timeout');
  assert.equal(launches,0);
 }
});
