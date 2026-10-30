import test from 'node:test';
import assert from 'node:assert/strict';
import { initialOverlayState,applyOverlayEvent } from '../../dsh-onboarding/overlay-state.mjs';
import { augmentConfirmationId } from '../../dsh-onboarding/augment-confirmation.mjs';
import { applyTeamConfirmation } from '../confirmation-apply.mjs';

function fixture(){
 const now=1000000,facts=initialOverlayState();
 const emit=(event,t)=>applyOverlayEvent(facts,{game:'lol',match:'one',t,...event},'one');
 emit({kind:'game_start',me:{champion:'安妮'}},now-180000);
 emit({kind:'augment_offer',roll:1,options:['甲','乙','丙']},now-179000);
 emit({kind:'augment_offer_closed',roll:1},now-178000);
 const old=facts.augmentRounds[0],id=augmentConfirmationId(facts,old);
 emit({kind:'augment_offer',roll:2,options:['丁','戊','己']},now);
 const calls=[],request={sourceDeviceId:'pc',status:'confirmed',localConfirmationId:id,roomMatchId:'room-match',choice:{name:'乙'}};
 const input={request,deviceId:'pc',facts,binding:{roomMatchId:'room-match',localMatch:'one',game:'lol'},room:{currentMatch:{id:'room-match'}},now,
  apply:async value=>{calls.push(value);old.confirmed=['乙'];old.confirmationSource='team-user-confirmed';old.confirmationId=id;}};
 return {input,facts,old,calls,emit};
}
test('an accepted late result updates its historical round after timeout/new panel and retries do not apply twice',async()=>{
 const f=fixture();assert.equal(await applyTeamConfirmation(f.input),'applied');assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].historical,true);assert.equal(f.calls[0].name,'乙');
 assert.equal(f.facts.augmentRounds[1].closed,false);assert.deepEqual(f.facts.augmentRounds[1].confirmed,[]);
 assert.equal(await applyTeamConfirmation(f.input),'applied');assert.equal(f.calls.length,1);
});
test('history compensation rejects another match, changed options, stale facts and conflicting real choices',async()=>{
 for(const kind of ['match','options','stale','conflict','ended']){
  const f=fixture();
  if(kind==='match')f.input.binding.localMatch='other';
  if(kind==='options')f.old.options=['改动后的选项'];
  if(kind==='stale')f.facts.at-=30001;
  if(kind==='conflict'){f.old.confirmed=['甲'];f.old.confirmationSource='log-confirmed';}
  if(kind==='ended')f.facts.ended=true;
  assert.equal(await applyTeamConfirmation(f.input),kind==='conflict'?'conflict':'obsolete');assert.equal(f.calls.length,0);
 }
});
test('an assumption or foreign device cannot invoke historical confirmation compensation',async()=>{
 const f=fixture();f.input.request.status='assumed';assert.equal(await applyTeamConfirmation(f.input),'obsolete');
 f.input.request.status='confirmed';f.input.deviceId='another-pc';assert.equal(await applyTeamConfirmation(f.input),null);assert.equal(f.calls.length,0);
});
