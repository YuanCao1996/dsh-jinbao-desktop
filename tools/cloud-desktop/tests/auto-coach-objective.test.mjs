import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudCoach } from '../auto-coach.mjs';

const base = () => ({
  game: 'lol', match: 'one', phase: 'InProgress', gameSeconds: 600,
  me: { champion: '安妮', level: 11, items: [] }, allies: [], enemies: [],
  offers: [], ownedAugments: [], revealedAugments: [], events: [],
});

function harness(getCurrent) {
  const state = { time: 10000, calls: 0, entries: [], questions: [] };
  const coach = createCloudCoach({
    view: () => ({ game: 'lol', match: 'one', updatedAt: state.time }),
    getContext: async () => ({ current: getCurrent() }),
    now: () => state.time,
    agent: {
      ask: async request => {
        state.calls++;
        state.questions.push(request.question);
        return '对面刚团灭，20 秒真空：推中塔，别回城。';
      },
    },
    publish: async entry => state.entries.push(entry),
  });
  return { state, coach };
}

test('a fresh objective wakes the coach with its own stage and map dimension', async () => {
  let current = base();
  const { state, coach } = harness(() => current);

  // The first poll legitimately opens an opening/ultimate turn; that is not what we test.
  await coach.tick();
  const baseline = state.calls;

  current = { ...current, events: [{ key: 'Ace:1', kind: 'Ace', time: '10:00', text: '团灭' }] };
  await coach.tick();
  assert.equal(state.calls, baseline + 1, 'a fresh ace must reach the model');
  const ace = state.entries.filter(entry => entry.key === 'ace');
  assert.equal(ace.length, 1);
  assert.equal(ace[0].dimension, 'map', 'objectives belong to the map dimension');

  // The same recorded objective must not keep firing on every poll.
  state.time += 5000;
  await coach.tick();
  assert.equal(state.entries.filter(entry => entry.key === 'ace').length, 1, 'consumed objective must not retrigger');
  coach.close();
});

test('an objective turn asks for multi-step reasoning with the tools, not a single shot', async () => {
  let current = base();
  const { state, coach } = harness(() => current);
  await coach.tick();
  current = { ...current, events: [{ key: 'Ace:9', kind: 'Ace', time: '12:00', text: '团灭' }] };
  await coach.tick();

  const question = state.questions.at(-1) ?? '';
  assert.match(question, /工作方式（多步/, 'the turn must ask for multi-step work');
  assert.match(question, /query_match_events|game_log_query/, 'events lookup must be offered');
  assert.match(question, /site_query|web_search/, 'retrieval must be offered');
  assert.match(question, /inspect_latest_screen/, 'screen reading must be offered');
  assert.match(question, /只输出播报正文/, 'the workflow must forbid narrating the tool use');
  coach.close();
});

test('a turret is mapped to the map dimension as well', async () => {
  let current = base();
  const { state, coach } = harness(() => current);
  await coach.tick();
  current = { ...current, events: [{ key: 'TurretKilled:7', kind: 'TurretKilled', time: '07:29', text: '防御塔被摧毁' }] };
  await coach.tick();
  assert.equal(state.entries.at(-1)?.key, 'turret');
  assert.equal(state.entries.at(-1)?.dimension, 'map');
  coach.close();
});

test('an auto-picked augment still opens a post-augment turn', async () => {
  let current = base();
  const { state, coach } = harness(() => current);
  await coach.tick();
  const before = state.entries.length;

  // The countdown defaulted to this augment: the player did not click it, but it is what
  // they now have to play around, so advice must account for it.
  current = { ...current, revealedAugments: ['坦克引擎'] };
  await coach.tick();
  assert.equal(state.entries.length, before + 1, 'auto-picked augment must reach the model');
  const entry = state.entries.at(-1);
  assert.equal(entry.key, 'postAugment');
  assert.equal(entry.dimension, 'augment');
  coach.close();
});
