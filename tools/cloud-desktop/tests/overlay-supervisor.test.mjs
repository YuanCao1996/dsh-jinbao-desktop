import test from 'node:test';
import assert from 'node:assert/strict';
import {createOverlaySupervisor} from '../overlay-supervisor.mjs';
function fixture(){
 let clock=1000,heartbeat=null,running=false,stop=false,external=false,release;
 const launches=[],reports=[];
 const supervisor=createOverlaySupervisor({stateDir:'unused',now:()=>clock,read:async()=>heartbeat,alive:()=>running,stopped:async()=>stop,
  publish:async v=>reports.push(v),launch:async recover=>{launches.push(recover);if(release)await release;return {external};}});
 return {supervisor,launches,reports,setClock:v=>clock=v,setHeartbeat:v=>heartbeat=v,setRunning:v=>running=v,setStop:v=>stop=v,setExternal:v=>external=v,setRelease:v=>release=v};
}
test('missing overlay recovers only after startup grace and repeated exits back off',async()=>{
 const f=fixture();await f.supervisor.start();await f.supervisor.tick();assert.deepEqual(f.launches,[false]);
 for(const at of [16000,31000,46000,61000]){f.setClock(at);await f.supervisor.tick();}
 assert.deepEqual(f.launches,[false,true,true,true]);assert.equal(f.reports.at(-1).state,'recovery_limited');
 f.setClock(77000);await f.supervisor.tick();assert.equal(f.launches.length,5);await f.supervisor.close();
});
test('fresh, collapsed and unresponsive live windows are never relaunched',async()=>{
 const f=fixture();f.setHeartbeat({pid:123,at:1000});f.setRunning(true);await f.supervisor.tick();assert.equal(f.reports.at(-1).state,'healthy');
 f.setClock(30000);await f.supervisor.tick();assert.equal(f.reports.at(-1).state,'unresponsive');assert.equal(f.launches.length,0);await f.supervisor.close();
});
test('user exit and service shutdown never resurrect the window',async()=>{
 const f=fixture();f.setStop(true);await f.supervisor.start();await f.supervisor.tick();assert.equal(f.launches.length,0);
 f.setStop(false);await f.supervisor.close();await f.supervisor.tick();assert.equal(f.launches.length,0);
});
test('concurrent ticks deduplicate launch and shutdown waits for launch completion',async()=>{
 const f=fixture();let release;f.setRelease(new Promise(resolve=>release=resolve));
 const first=f.supervisor.start(),second=f.supervisor.tick();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.launches.length,1);let closed=false;const closing=f.supervisor.close().then(()=>closed=true);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);release();await Promise.all([first,second,closing]);assert.equal(closed,true);
});
test('a restored legacy overlay is left to its own host',async()=>{
 const f=fixture();f.setExternal(true);await f.supervisor.start();f.setClock(600000);await f.supervisor.tick();assert.deepEqual(f.launches,[false]);await f.supervisor.close();
});
