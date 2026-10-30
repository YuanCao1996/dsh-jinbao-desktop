import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudCoach} from '../auto-coach.mjs';

function fixture(game='lol') {
 let time=10000,phase='InProgress',updatedAt=10000;
 let current={game,match:'one',phase,gameSeconds:180,me:{champion:'安妮',level:6,items:[]},enemies:[],offers:[],ownedAugments:[]};
 const entries=[],statuses=[];
 const view=()=>({game:current.game,match:current.match,phase,updatedAt});
 return {entries,statuses,view,now:()=>time,getContext:async()=>({current}),
  advance(ms){time+=ms;updatedAt=time;},pause(){phase='CapturePaused';},
  switchMatch(){current={...current,match:'two'};},
  loseTimestamp(){updatedAt=undefined;},
  options:{view,getContext:async()=>({current}),now:()=>time,publish:async e=>entries.push(e),publishStatus:async s=>statuses.push(s)}};
}

test('an old match failure cannot mark the next match failed or delay its first advice',async()=>{
 const f=fixture();let reject,calls=0;
 const coach=createCloudCoach({...f.options,agent:{ask:()=>++calls===1?new Promise((_r,r)=>reject=r):Promise.resolve('新局建议')}});
 const first=coach.tick();while(!reject)await new Promise(r=>setImmediate(r));
 f.switchMatch();reject(Error('Old task failed'));await first;
 assert.equal(f.statuses.some(s=>s.match==='two'&&s.state==='failed'),false);
 await coach.tick();assert.equal(calls,2);assert.equal(f.entries.at(-1).match,'two');coach.close();
});

test('advice finishing after capture pauses is not broadcast',async()=>{
 const f=fixture();const coach=createCloudCoach({...f.options,agent:{ask:async()=>{f.pause();return '过期画面建议';}}});
 await coach.tick();assert.equal(f.entries.length,0);assert.equal(f.statuses.some(s=>s.state==='published'),false);coach.close();
});

test('missing acquisition timestamp cannot start an automatic model request',async()=>{
 const f=fixture();f.loseTimestamp();let calls=0;
 const coach=createCloudCoach({...f.options,agent:{ask:async()=>{calls++;return '建议';}}});
 await coach.tick();assert.equal(calls,0);coach.close();
});

test('a previous match cooldown does not delay a fresh match',async()=>{
 const f=fixture();let calls=0;
 const coach=createCloudCoach({...f.options,agent:{ask:async()=>{if(++calls===1)throw Error('Failed');return '新局建议';}}});
 await coach.tick();f.advance(100);f.switchMatch();await coach.tick();
 assert.equal(calls,2);assert.equal(f.entries.at(-1).match,'two');coach.close();
});

for(const game of ['wzry','generic'])test(`${game} also discards advice when acquisition pauses during inference`,async()=>{
 const f=fixture(game);const coach=createCloudCoach({...f.options,agent:{ask:async()=>{f.pause();return '已暂停的建议';}}});
 await coach.tick();assert.equal(f.entries.length,0);coach.close();
});

test('switching matches during context retrieval does not submit an old task',async()=>{
 const f=fixture();let calls=0;
 const coach=createCloudCoach({...f.options,getContext:async()=>{const result=await f.getContext();f.switchMatch();return result;},agent:{ask:async()=>{calls++;return '旧局';}}});
 await coach.tick();assert.equal(calls,0);coach.close();
});
