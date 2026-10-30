import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSetupServer } from '../../dsh-onboarding/server.mjs';

test('local team page and commands share setup nonce boundary without exposing cloud credentials', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'team-setup-'));
  let setup;
  t.after(async () => { await setup?.close(); await rm(stateDir, { recursive: true, force: true }); });
  const values = new Map([['JINBAO_SERVICE_TOKEN', 'jc_' + 'b'.repeat(64)]]);
  const room = { id: 'room', name: '我的队伍', selfMemberId: 'member', ownerMemberId: 'member', members: [{ id: 'member', displayName: '队长' }], messageCount: 0, currentMatch: null };
  setup = await createSetupServer({ port: 0, stateDir, teamRooms: true,
    credentials: { resolve: async key => values.has(key) ? { value: values.get(key) } : null, set: async (key, value) => values.set(key, value), unset: async key => values.delete(key) },
    fetchImpl: async url => {
      const path = new URL(url).pathname;
      if (path.endsWith('/dashboard')) return Response.json({ room, messages: { items: [], cursor: 0, hasMore: false }, tasks: { items: [] },
        memories: { items: [] }, budget: { authorized: false }, connections: { items: [] }, confirmations: { items: [] } });
      if (path.endsWith('/messages')) return Response.json({ items: [], cursor: 0, hasMore: false });
      if (path.endsWith('/tasks') || path.endsWith('/memories')) return Response.json({ items: [] });
      if (path.endsWith('/budget')) return Response.json({ authorized: false });
      return Response.json(room);
    } });
  const [base, nonce] = setup.url.split('/#');
  const request = (path, data, headers = {}) => fetch(base + path, { method: data === undefined ? 'GET' : 'POST',
    headers: { 'X-Jinbao-Setup': nonce, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  assert.equal((await fetch(base + '/api/team/status')).status, 403);
  assert.equal((await request('/api/team/status', undefined, { Origin: 'https://evil.test' })).status, 403);
  const page = await fetch(base + '/team-room');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('Content-Security-Policy'), /script-src 'self'/);
  const html = await page.text(); assert.match(html, /队伍聊天/);
  assert.equal(html.includes(values.get('JINBAO_SERVICE_TOKEN')), false);
  assert.equal((await fetch(base + '/team-assets/page.mjs')).status, 200);
  const created = await request('/api/team/command', { action: 'create', data: { name: '我的队伍', displayName: '队长' } });
  assert.equal(created.status, 200);
  const snapshot = await (await request('/api/team/status')).json();
  assert.equal(snapshot.room.id, 'room'); assert.equal(snapshot.mode, 'team');
  assert.equal(JSON.stringify(snapshot).includes(values.get('JINBAO_SERVICE_TOKEN')), false);
  assert.equal(JSON.parse(await readFile(join(stateDir, 'team-room-overlay.json'), 'utf8')).mode, 'team');
});
