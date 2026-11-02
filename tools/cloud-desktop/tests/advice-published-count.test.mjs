import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudCoach } from '../auto-coach.mjs';

test('a written broadcast is counted even when the context moves on before the status write', async () => {
  let time = 10000, match = 'one';
  const current = {
    game: 'lol', match: 'one', phase: 'InProgress', gameSeconds: 180,
    me: { champion: '安妮', level: 6, items: [] }, allies: [], enemies: [], offers: [], ownedAugments: ['旧强化'],
  };
  const traces = [], entries = [];
  const coach = createCloudCoach({
    view: () => ({ game: 'lol', match, updatedAt: time }),
    getContext: async () => ({ current }),
    now: () => time,
    agent: { ask: async () => '按全部强化调整打法。' },
    trace: event => traces.push(event),
    // Simulate the match switching right after the broadcast is appended.
    publish: async entry => { entries.push(entry); match = 'two'; },
    publishStatus: async () => {},
  });
  await coach.tick();
  coach.close();

  assert.equal(entries.length, 1, 'the broadcast was written');
  assert.ok(traces.some(event => event.action === 'coach_published'),
    'advicePublished must be counted at write time, not only when status still applies');
  assert.equal(traces.filter(event => event.action === 'coach_published').length, 1, 'counted exactly once');
});

test('a discarded reply is not counted as published', async () => {
  let time = 10000;
  const current = {
    game: 'lol', match: 'one', phase: 'InProgress', gameSeconds: 180,
    me: { champion: '安妮', level: 6, items: [] }, allies: [], enemies: [], offers: [], ownedAugments: ['旧强化'],
  };
  const traces = [], entries = [];
  const coach = createCloudCoach({
    view: () => ({ game: 'lol', match: 'one', updatedAt: time, ended: true }),
    getContext: async () => ({ current }),
    now: () => time,
    agent: { ask: async () => '按全部强化调整打法。' },
    trace: event => traces.push(event),
    publish: async entry => entries.push(entry),
    publishStatus: async () => {},
  });
  await coach.tick();
  coach.close();

  assert.equal(entries.length, 0);
  assert.equal(traces.filter(event => event.action === 'coach_published').length, 0);
});
