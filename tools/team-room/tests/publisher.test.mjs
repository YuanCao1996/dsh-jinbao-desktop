import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeamPublisher, projectTeamFacts } from '../publisher.mjs';
const now = 100_000;
const facts = () => ({ game: 'lol', match: 'local-game', at: now, mode: 'KIWI', phase: 'InProgress', gameSeconds: 200,
  me: { champion: '安妮', championAlias: 'Annie', level: 8, gold: 1200, teamKills: 3, enemyKills: 2, items: [], summonerName: 'private-player', token: 'secret' },
  allies: [], enemies: [], ownedAugments: ['强化甲'], offers: ['强化乙', '强化丙', '强化丁'],
  augmentRounds: [{ id: 1, confirmed: ['强化甲'], closed: false }], chat: ['private-chat'], rawLogs: 'raw-private' });
test('publisher projects game fields only, with confirmed selections and at most three current candidates', () => {
  let version = 1;
  const packets = projectTeamFacts(facts(), { deviceId: 'device', roomMatchId: 'match', nextVersion: () => ++version, now });
  assert.equal(packets.find(packet => packet.kind === 'augment_candidates').payload.candidates.length, 3);
  assert.equal(packets.find(packet => packet.kind === 'augment_selected').payload.augment.confirmed, true);
  assert.doesNotMatch(JSON.stringify(packets), /private|secret|summonerName|rawLogs|token/);
  assert.equal(new Set(packets.map(packet => packet.stateVersion)).size, packets.length);
});
test('unknown economy remains unknown and stale snapshots do not get uploaded', () => {
  const input = facts(); input.me.gold = undefined;
  const packets = projectTeamFacts(input, { deviceId: 'device', roomMatchId: 'match', nextVersion: () => 1, now });
  assert.equal(packets.find(packet => packet.kind === 'member_state').payload.gold, null);
  assert.deepEqual(projectTeamFacts({ ...input, at: now - 31_000 }, { now }), []);
});
test('fresh candidate refresh is sent immediately rather than waiting for heartbeat', async () => {
  let current = facts(), sequence = 1; const uploaded = [];
  const publisher = createTeamPublisher({ getFacts: async () => current, client: { publish: async (_id, packet) => uploaded.push(packet) },
    deviceId: 'device', nextVersion: () => ++sequence, now: () => now });
  const context = { room: { id: 'room', currentMatch: { id: 'match', game: 'lol' } }, binding: { roomMatchId: 'match', localMatch: 'local-game', game: 'lol' } };
  await publisher.tick(context); const initial = uploaded.length;
  await publisher.tick(context); assert.equal(uploaded.length, initial);
  current = { ...current, offers: ['刷新甲', '强化丙', '强化丁'] };
  await publisher.tick(context);
  assert.equal(uploaded.length, initial + 1);
  assert.equal(uploaded.at(-1).payload.candidates[0].name, '刷新甲');
  current = facts();
  await publisher.tick(context);
  assert.equal(uploaded.length, initial + 2, 'a correction back to the original candidates must not be mistaken for an unchanged heartbeat');
  assert.equal(uploaded.at(-1).payload.candidates[0].name, current.offers[0]);
});
test('publisher requires explicit same-match binding and stops when local match changes', async () => {
  let current = facts(), calls = 0;
  const publisher = createTeamPublisher({ getFacts: async () => current, client: { publish: async () => calls++ }, deviceId: 'device', nextVersion: () => 1, now: () => now });
  const room = { id: 'room', currentMatch: { id: 'match', game: 'lol' } };
  assert.equal((await publisher.tick({ room })).state, 'binding_required');
  current = { ...current, match: 'next-game' };
  await publisher.tick({ room, binding: { roomMatchId: 'match', localMatch: 'local-game', game: 'lol' } });
  assert.equal(calls, 0);
});

test('clock/passive gold changes do not flood uploads or resend immutable selections every poll', async () => {
  let time = now, current = facts(), version = 0; const uploads = [];
  current.augmentRounds[0].options = ['强化甲', '强化乙', '强化丙'];
  const publisher = createTeamPublisher({ getFacts: async () => current, client: { publish: async (_id, packet) => uploads.push(packet) },
    deviceId: 'device', nextVersion: () => ++version, now: () => time });
  const room = { id: 'room', membershipVersion: 1, currentMatch: { id: 'match', game: 'lol' } }, binding = { roomMatchId: 'match', localMatch: 'local-game', game: 'lol' };
  for (let tick = 0; tick < 20; tick++) {
    time = now + tick * 3000; current = { ...current, at: time, gameSeconds: 200 + tick * 3, me: { ...current.me, gold: 1200 + tick * 10 } };
    await publisher.tick({ room, binding });
  }
  assert.equal(uploads.filter(packet => packet.kind === 'augment_selected').length, 1);
  assert.ok(uploads.length < 50);
  const before = uploads.length;
  await publisher.tick({ room: { ...room, membershipVersion: 2 }, binding });
  assert.ok(uploads.length > before, 'a new permission generation must get an immediate fresh projection');
});
