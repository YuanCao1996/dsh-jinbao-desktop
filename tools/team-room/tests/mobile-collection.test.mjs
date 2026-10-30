import test from 'node:test';
import assert from 'node:assert/strict';
import { createMobileTeamSession } from '../mobile-session.mjs';

function setup() {
  const stored = new Map(), calls = [], room = { id: 'room', selfMemberId: 'me', ownerMemberId: 'me', members: [], currentMatch: null };
  let enabled = false, localFailure = false, selected;
  const collection = { async api(action, data) {
    calls.push({ action, ...data });
    if (localFailure) throw new Error('local-collection-unavailable');
    if (action === 'select' && selected !== data.roomId) { selected = data.roomId; enabled = false; }
    if (action === 'sharing') enabled = data.enabled;
    if (action === 'bind-match' || action === 'start-match') enabled = true;
    return { available: true, enabled, state: enabled ? 'sharing' : 'not_shared' };
  } };
  const session = createMobileTeamSession({ accountKey: 'synthetic-account', collection,
    storage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) },
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname;
      assert.equal(path.includes('observations'), false, 'the WebView never uploads raw or projected game data itself');
      if (path.endsWith('/dashboard')) return Response.json({ room, messages: { items: [], cursor: 0, hasMore: false },
        tasks: { items: [] }, budget: {}, memories: { items: [] }, connections: { items: [] }, confirmations: { items: [] } });
      if (path.endsWith('/leave')) return Response.json({ left: true });
      return Response.json(room);
    } });
  return { session, calls, stored, setFailure: value => { localFailure = value; } };
}

test('phone UI delegates consent and binding to native collection, retains consent on refresh and disables before leaving', async () => {
  const { session, calls, stored } = setup();
  await session.api('open', { roomId: 'room' });
  assert.equal(session.view().shareGameInfo, false);
  await session.api('sharing', { enabled: true });
  assert.equal(session.view().shareGameInfo, true);
  await session.api(); assert.equal(session.view().shareGameInfo, true);
  await session.api('bind-match');
  assert.ok(calls.some(call => call.action === 'bind-match' && call.roomId === 'room'));
  await session.api('leave');
  assert.equal(calls.at(-1).action, 'sharing'); assert.equal(calls.at(-1).enabled, false);
  assert.equal(session.view().room, null);
  assert.equal([...stored.values()].some(value => /token|snapshot|ocr|playing_hero/.test(value)), false);
});

test('local collection failure keeps healthy room chat connected and offers an unavailable collection state', async () => {
  const { session, setFailure } = setup(); await session.api('open', { roomId: 'room' });
  setFailure(true); const state = await session.api();
  assert.equal(state.connected, true); assert.equal(state.room.id, 'room');
  assert.equal(state.collectionAvailable, false); assert.equal(state.sharing, 'team_unavailable');
});
