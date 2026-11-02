import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTiebreakAnswer,tiebreakPick,TIEBREAK_QUESTION} from '../vision-tiebreak.mjs';
import {initialOverlayState,applyOverlayEvent} from '../overlay-state.mjs';

const OPTIONS=[{name:'珠光护手',slot:0},{name:'尤里卡',slot:1},{name:'缩小引擎',slot:2}];

test('a plain slot number maps to the right card',()=>{
 assert.equal(parseTiebreakAnswer('2'),1);
 assert.equal(parseTiebreakAnswer('第3张'),2);
 assert.equal(parseTiebreakAnswer('1.'),0);
 assert.equal(parseTiebreakAnswer(' 1 '),0);
});

test('an unsure or unusable answer never becomes a pick',()=>{
 for(const value of ['0','看不清','无法判断','',null,undefined,'可能是1也可能是2','张三']){
  assert.equal(parseTiebreakAnswer(value),null,`${value} 不应解析出卡片`);
  assert.equal(tiebreakPick({answer:value,options:OPTIONS}),null);
 }
});

test('a decisive answer becomes a self pick carrying the card name',()=>{
 const pick=tiebreakPick({answer:'2',options:OPTIONS,roll:3});
 assert.equal(pick.kind,'augment_picked');
 assert.equal(pick.who,'self');
 assert.equal(pick.name,'尤里卡');
 assert.equal(pick.roll,3);
 assert.equal(pick.source,'vision-model');
 assert.equal(pick.confidence,'high');
});

test('a slot the panel does not have stays unanswered',()=>{
 assert.equal(tiebreakPick({answer:'3',options:OPTIONS.slice(0,2)}),null,'第 3 张不存在时不能编造名字');
 assert.equal(tiebreakPick({answer:'1',options:[]}),null);
});

test('the model pick counts as owned and suppresses the dialog',()=>{
 const state=initialOverlayState();
 let at=1000;
 const emit=event=>applyOverlayEvent(state,{game:'lol',match:'m',t:++at,...event},'m');
 emit({kind:'game_start',me:{champion:'安妮'}});
 emit({kind:'augment_offer',roll:1,reroll:false,options:OPTIONS});
 emit({kind:'augment_offer_closed',roll:1});
 emit(tiebreakPick({answer:'1',options:OPTIONS,roll:1}));
 assert.deepEqual(state.ownedAugments,['珠光护手']);
});

test('the question tells the model the exact answer contract',()=>{
 assert.match(TIEBREAK_QUESTION,/1 = 第一张/);
 assert.match(TIEBREAK_QUESTION,/看不清就回答 0/);
 assert.match(TIEBREAK_QUESTION,/不要解释/);
});
