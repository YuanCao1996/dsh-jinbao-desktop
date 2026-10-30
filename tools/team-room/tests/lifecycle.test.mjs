import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamBridge } from '../bridge.mjs';
import { createMobileTeamSession } from '../mobile-session.mjs';
function server() {
  let closed = false;
  const room = { id: 'room', name: '可恢复队伍', selfMemberId: 'me', ownerMemberId: 'me', canAuthorizeBudget: true,
    members: [], currentMatch: null, messageCount: 0 };
  const fetchImpl = async (url, request) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/closed-rooms')) return Response.json({ items: closed ? [{ id: room.id, name: room.name, restoreUntil: 9999999999999 }] : [], cursor: closed ? 1 : 0, hasMore: false });
    if (path.endsWith('/dissolve')) { closed = true; return Response.json({ id: room.id, restoreUntil: 9999999999999 }); }
    if (path.endsWith('/restore')) { closed = false; return Response.json(room); }
    if (closed) return Response.json({ error: 'room_unavailable' }, { status: 404 });
    if (path.endsWith('/dashboard')) return Response.json({ room, messages: { items: [], cursor: 0, hasMore: false }, tasks: { items: [] },
      memories: { items: [] }, connections: { items: [] }, confirmations: { items: [] }, budget: { authorized: false, remaining: 0 } });
    return Response.json(room);
  };
  return { fetchImpl, close: () => { closed = true; } };
}

test('desktop dissolution clears overlay and sharing; restore opens history without reviving the collection binding', async t => {
  const backend = server(), stateDir = await mkdtemp(join(tmpdir(), 'team-lifecycle-client-'));
  let bridge;
  t.after(async () => { await bridge?.close(); await rm(stateDir, { recursive: true, force: true }); });
  bridge = await createTeamBridge({ stateDir, serviceBaseUrl: 'https://example.test', getToken: () => 'fixture', fetchImpl: backend.fetchImpl, pollMs: 100000 });
  await bridge.command('create', { name: '可恢复队伍', displayName: '本人' });
  await bridge.command('sharing', { enabled: true });
  await bridge.command('dissolve');
  assert.equal(bridge.view().room, null);
  assert.equal((await bridge.command('closed-list')).items[0].id, 'room');
  let saved = JSON.parse(await readFile(join(stateDir, 'team-room-settings.json'), 'utf8'));
  assert.equal(saved.activeRoomId, null); assert.equal(saved.shareGameInfo, false); assert.equal(saved.binding, null);
  await bridge.command('restore', { roomId: 'room' });
  assert.equal(bridge.view().room.id, 'room'); assert.equal(bridge.view().shareGameInfo, false);
  saved = JSON.parse(await readFile(join(stateDir, 'team-room-settings.json'), 'utf8'));
  assert.equal(saved.binding, null); assert.equal(saved.shareGameInfo, false);
});

test('mobile dissolution and discovering a closed room disable native sharing, which recovery does not re-enable', async () => {
  const backend = server(), storage = new Map(), calls = []; let enabled = false;
  const session = createMobileTeamSession({ accountKey: 'fixture', fetchImpl: backend.fetchImpl,
    storage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    collection: { async api(action, data) {
      calls.push({ action, ...data }); if (action === 'sharing') enabled = data.enabled;
      return { available: true, enabled, state: enabled ? 'sharing' : 'not_shared' };
    } } });
  await session.api('open', { roomId: 'room' }); await session.api('sharing', { enabled: true });
  await session.api('dissolve'); assert.equal(enabled, false); assert.equal(session.view().room, null);
  assert.equal((await session.api('closed-list')).items[0].id, 'room');
  await session.api('restore', { roomId: 'room' }); assert.equal(session.view().shareGameInfo, false);
  await session.api('sharing', { enabled: true }); backend.close(); await session.api();
  assert.equal(enabled, false); assert.equal(session.view().room, null);
  assert.ok(calls.filter(value => value.action === 'sharing' && value.enabled === false).length >= 2);
});
