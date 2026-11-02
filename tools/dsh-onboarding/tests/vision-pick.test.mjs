import test from 'node:test';
import assert from 'node:assert/strict';
import {initialOverlayState,applyOverlayEvent,overlayView} from '../overlay-state.mjs';
import {augmentConfirmation} from '../augment-confirmation.mjs';

// The card watcher lands a self pick; these assert the two behaviours the user asked for:
// it counts as owned, and it stops the confirmation dialog from appearing.
const setup=()=>{
 const state=initialOverlayState();
 let at=1000;
 const emit=event=>applyOverlayEvent(state,{game:'lol',match:'m',t:++at,...event},'m');
 emit({kind:'game_start',me:{champion:'安妮'}});
 emit({kind:'augment_offer',roll:1,reroll:false,options:[{name:'珠光护手',slot:0},{name:'尤里卡',slot:1},{name:'缩小引擎',slot:2}]});
 emit({kind:'augment_offer_closed',roll:1});
 return {state,emit,now:()=>at};
};

test('a vision-confirmed pick counts as owned without any manual confirmation',()=>{
 const {state,emit,now}=setup();
 emit({kind:'augment_picked',who:'self',name:'珠光护手',augment:'珠光护手',roll:1,source:'vision-click',confidence:'high'});
 assert.deepEqual(state.ownedAugments,['珠光护手'],'the highlighted card must become an owned augment');
 assert.match(overlayView(state).advice,/本局已选海克斯[\s\S]*珠光护手/);
 assert.equal(augmentConfirmation(state,[],now()+4000),null,'a confirmed round must not prompt');
});

test('without the watcher the round stays unconfirmed and still prompts',()=>{
 const {state,now}=setup();
 assert.deepEqual(state.ownedAugments,[]);
 const prompt=augmentConfirmation(state,[],now()+4000);
 assert.ok(prompt,'an unrecognised pick must still ask the player');
 assert.equal(prompt.options.length,3,'the prompt only offers the cards on the panel');
});

test('a low-confidence or ambiguous watcher result never becomes owned',()=>{
 const {state,emit}=setup();
 // The watcher reports its reasoning; only a decisive slot becomes an event, so a
 // non-decisive run simply emits nothing and the dialog covers it.
 emit({kind:'augment_picked',who:'unknown',name:'尤里卡',roll:1,source:'ocr-inferred',confidence:'low'});
 assert.deepEqual(state.ownedAugments,[],'inferred picks must not be treated as owned');
});
