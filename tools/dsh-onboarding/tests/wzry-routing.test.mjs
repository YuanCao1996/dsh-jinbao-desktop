import test from 'node:test';
import assert from 'node:assert/strict';
import { WZRY_ADAPTER } from '../../dsh-coach-server/lib/adapters/wzry.js';
import { projectWzryFacts } from '../../dsh-coach-server/lib/adapters/wzry-facts.js';
import { createMatchTracker } from '../../dsh-coach-server/lib/match-tracker.js';
import { createOverlayRouter, overlayView } from '../overlay-state.mjs';

const interaction = (time, t, hero = '孙尚香') => ({ game: 'wzry', t, message:
  'MOBA局内互动调用LLM: key=system_notice, context=' + JSON.stringify({ game_time: time,
    self: { name: '测试玩家', hero, lane: '发育路' }, our_team: [{ hero: '孙尚香', name: '测试玩家' }, { hero: '张飞', name: '队友' }],
    enemy_team: [{ hero: '鲁班七号', name: '对手' }] }) });

test('real APP interaction and tactical-brief formats populate clock, hero, teams and KDA', () => {
  const facts = projectWzryFacts(WZRY_ADAPTER.log.classify(interaction('09:41', 1000)));
  assert.equal(facts.state.time, 581);
  assert.equal(facts.me.champion, '孙尚香');
  assert.equal(facts.allies.length, 2);
  const brief = { game: 'wzry', t: 1001, message: 'MOBA_TACTICAL_BRIEF_CONTENT text=' +
    '- 对局时间：9:42\n- 本人：玩家=测试玩家；英雄=孙尚香；分路=发育路\n- 我方阵容：孙尚香、张飞\n- 敌方阵容：鲁班七号\n- 本人KDA：3/1/5' };
  const router = createOverlayRouter();
  router.apply(interaction('09:41', 1000), 'phone'); router.apply(brief, 'phone');
  const view = overlayView(router.state());
  assert.equal(view.gameTime, '09:42');
  assert.match(view.summary, /孙尚香.*3\/1\/5/);
  assert.match(view.players, /友 孙尚香/); assert.match(view.players, /敌 鲁班七号/);
  assert.match(view.augments, /没有海克斯/);
  assert.equal(projectWzryFacts({ kind: 'brief', text: '12:34 现实时间；坐标 22:10' }), null);
  assert.equal(projectWzryFacts({ kind: 'ocr', text: '09:42' }), null);
});

test('a clock glitch stays in its match; confirmed rollback isolates the next match in the same file', () => {
  const router = createOverlayRouter();
  router.apply(interaction('19:00', 1000), 'phone');
  const first = router.state().match;
  router.state().chat.push({ role: 'user', text: '上一局问题' });
  router.apply(interaction('00:20', 2000), 'phone');
  assert.equal(router.state().match, first); assert.equal(router.state().gameSeconds, 1140);
  router.apply(interaction('19:02', 3000), 'phone');
  assert.equal(router.state().match, first);
  router.apply(interaction('00:20', 4000, '安琪拉'), 'phone');
  router.apply(interaction('00:21', 5000, '安琪拉'), 'phone');
  assert.notEqual(router.state().match, first);
  assert.equal(router.state().chat.length, 0);
  assert.equal(router.state().me.champion, '安琪拉');
  router.apply({ game: 'wzry', match: first, at: 6000, broadcast: '上一局迟到回复' }, 'coach');
  assert.doesNotMatch(overlayView(router.state()).advice, /迟到回复/);
});

test('dual games keep separate facts and replies; lobby phases do not steal the active match', () => {
  const router = createOverlayRouter();
  router.apply(interaction('01:00', 1000), 'phone');
  const phoneMatch = router.state().match;
  router.apply({ game: 'lol', t: 1100, kind: 'state', me: { champion: '锐雯' }, state: { time: 10 } }, 'pc');
  router.apply({ game: 'lol', t: 1200, kind: 'phase', phase: 'Lobby' }, 'client');
  assert.equal(router.state().game, 'wzry');
  router.apply({ game: 'wzry', t: 1300, kind: 'event', name: 'GameEnd', time: 60 }, 'phone');
  assert.equal(router.state().game, 'lol');
  assert.equal(router.state().gameSeconds, 10);
  router.apply({ game: 'wzry', match: phoneMatch, at: 1400, broadcast: '王者回复' }, 'coach');
  assert.doesNotMatch(overlayView(router.state()).advice, /王者回复/);
});

test('capture-provided match identity survives rotation and ignores suspect clock frames', () => {
  const router = createOverlayRouter();
  router.apply({ ...interaction('04:00', 1000), match: 'capture#1' }, 'part1');
  router.apply({ ...interaction('04:01', 2000), match: 'capture#1' }, 'part2');
  assert.equal(router.state().match, 'capture#1');
  router.apply({ ...interaction('00:01', 3000), match: 'capture#1', clockPending: true }, 'part2');
  assert.equal(router.state().gameSeconds, 241);
  const tracker = createMatchTracker();
  assert.equal(tracker.identify('wzry','phone',{seconds:1200,at:1000}).match,'phone#1');
  assert.equal(tracker.identify('wzry','phone',{seconds:10,at:2000}).pending,true);
  assert.equal(tracker.identify('wzry','phone',{seconds:10,at:2500}).pending,true);
  assert.equal(tracker.identify('wzry','phone',{seconds:11,at:3000}).match,'phone#2');
});

test('APP lifecycle logs end the current match and clear facts when the next pregame starts', () => {
  const router = createOverlayRouter();
  router.apply(interaction('20:00', 1000), 'phone');
  router.state().chat.push({role:'user',text:'旧局问题'});
  router.apply({game:'wzry',t:2000,message:'MOBA对局结束: result=victory, serviceContinuing=true'},'phone');
  assert.equal(router.state().ended,true);
  router.apply({game:'wzry',t:3000,message:'MOBA新对局赛前会话开始: phase=ban_pick, generation=8, recorderStarted=true'},'phone');
  assert.equal(router.state().ended,false);
  assert.equal(router.state().chat.length,0);
  assert.equal(router.state().gameSeconds,null);
  router.apply(interaction('00:01',4000,'安琪拉'),'phone');
  assert.equal(router.state().me.champion,'安琪拉');
  assert.equal(router.state().gameSeconds,1);
});
