import test from 'node:test';
import assert from 'node:assert/strict';
import {createEquipmentCoach} from '../equipment-context.mjs';

const view=(owned,items=[{name:'残疫',completed:true}])=>({
  game:'lol',match:'one',matchStartedAt:1,at:Date.now(),phase:'InProgress',ended:false,
  me:{champion:'安妮',items},enemies:[],ownedAugments:owned,augmentRounds:[],
});
const settle=()=>new Promise(r=>setTimeout(r,25));

test('a confirmed augment refreshes the build advice even while the voice queue is busy',async()=>{
 const calls=[];
 let allowed=true,state=view(['甲']);
 const coach=createEquipmentCoach({getState:()=>state,agentChat:async request=>{calls.push(request);return '下一件做中娅沙漏';},
  save:async()=>{},onAdvice:async()=>{},canRequest:()=>allowed,debounceMs:0,cooldownMs:60000});

 // Baseline turn: it records the augments the advice was built from.
 coach.tick();await settle();
 assert.equal(calls.length,1,'the first turn runs normally');
 assert.ok(!calls[0].urgent,'the baseline turn is not a confirmation');

 // The player confirms another augment while the voice queue is busy.
 allowed=false;state=view(['甲','乙']);
 coach.tick();await settle();
 assert.equal(calls.length,2,'a confirmation must not wait for a quiet queue');
 assert.equal(calls[1].urgent,true);
 assert.equal(state.equipment,'下一件做中娅沙漏');

 // A change that is not a confirmation still waits.
 state=view(['甲','乙'],[{name:'残疫',completed:true},{name:'虚空之杖',completed:true}]);
 coach.tick();await settle();
 assert.equal(calls.length,2,'an ordinary change still respects the busy gate');
 assert.match(state.equipmentStatus??'',/低频更新|等待低频|正在结合/);
 coach.close();
});
