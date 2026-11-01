import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeamPublisher, projectTeamFacts } from '../publisher.mjs';
import { initialOverlayState, applyOverlayEvent } from '../../dsh-onboarding/overlay-state.mjs';
import { cleanGameData } from '../../dsh-coach-server/lib/game-memory.js';
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
test('only recent recognized LoL event IDs are shared with fixed descriptions and stable deduplication', async () => {
  const input = facts(); input.events = [{ key: 'TurretKilled:42', time: '03:18', text: 'private-player destroyed tower' },
    { key: 'Ace:43', time: '03:19', text: 'private-player' }, { key: 'ChampionKill:44', time: '03:19', text: 'private' },
    { key: 'TurretKilled:45', time: '02:00', text: 'old' }, { key: '["TurretKilled",199,"private"]', time: '03:19', text: 'private' }];
  let sequence = 0; const sent = [], publisher = createTeamPublisher({ getFacts: async () => input,
    client: { publish: async (_room, packet) => sent.push(packet) }, deviceId: 'device', nextVersion: () => ++sequence, now: () => now });
  const context = { room: { id: 'room', currentMatch: { id: 'match', game: 'lol' } }, binding: { roomMatchId: 'match', localMatch: 'local-game', game: 'lol' } };
  await publisher.tick(context); await publisher.tick(context);
  const events = sent.filter(packet => packet.kind === 'key_event');
  assert.deepEqual(events.map(event => event.payload.type), ['tower_destroyed', 'team_aced']);
  assert.deepEqual(events.map(event => event.payload.summary), ['防御塔被摧毁', '团灭']);
  assert.doesNotMatch(JSON.stringify(events), /private|ChampionKill/);
  const other = projectTeamFacts(input, { deviceId: 'another', roomMatchId: 'match', nextVersion: () => ++sequence, now });
  assert.equal(other.find(packet => packet.kind === 'key_event').payload.eventId, events[0].payload.eventId);
});
test('real overlay event survives the organized facts projection without player details', () => {
  const state = initialOverlayState();
  applyOverlayEvent(state, { game: 'lol', kind: 'game_start', t: now, me: { champion: '安妮' } }, 'local-game');
  applyOverlayEvent(state, { game: 'lol', kind: 'event', name: 'TurretKilled', id: 42, time: 198, t: now,
    killer: 'private-player', turret: 'private-turret' }, 'local-game');
  const input = cleanGameData({ ...state, at: now, gameSeconds: 200 });
  const packets = projectTeamFacts(input, { deviceId: 'device', roomMatchId: 'match', nextVersion: () => 1, now });
  const event = packets.find(packet => packet.kind === 'key_event');
  assert.equal(event?.payload.type, 'tower_destroyed'); assert.equal(event.payload.gameTimeSeconds, 198);
  assert.doesNotMatch(JSON.stringify(event), /private/);
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
test('reset stops pending projections before upload and remaining packets after an in-flight request', async () => {
  let resolveFacts, resolveUpload, sequence = 0, calls = 0;
  let factsPromise = new Promise(resolve => { resolveFacts = resolve; });
  const client = { publish: async () => { calls++; if (calls === 1) await new Promise(resolve => { resolveUpload = resolve; }); } };
  const publisher = createTeamPublisher({ getFacts: () => factsPromise, client, deviceId: 'device', nextVersion: () => ++sequence, now: () => now });
  const room = { id: 'room', currentMatch: { id: 'match', game: 'lol' } }, binding = { roomMatchId: 'match', localMatch: 'local-game', game: 'lol' };
  const pendingFacts = publisher.tick({ room, binding }); publisher.reset(); resolveFacts(facts());
  assert.equal((await pendingFacts).state, 'cancelled'); assert.equal(calls, 0);
  factsPromise = Promise.resolve(facts());
  const uploading = publisher.tick({ room, binding });
  while (!resolveUpload) await new Promise(resolve => setImmediate(resolve));
  publisher.reset(); resolveUpload();
  assert.equal((await uploading).state, 'cancelled'); assert.equal(calls, 1);
  await publisher.tick({ room, binding }); assert.ok(calls > 2, 'new authorization may publish a fresh projection');
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
