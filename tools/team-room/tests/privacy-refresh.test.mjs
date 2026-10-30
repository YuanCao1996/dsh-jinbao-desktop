import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createTeamBridge } from '../bridge.mjs';
import { createMobileTeamSession } from '../mobile-session.mjs';
test('desktop and phone discard cached identities and personal memory when privacy changes, including failed reload', async t => {
  for (const platform of ['desktop', 'mobile']) for (const fail of [false, true]) {
    let version = 0, failReload = fail;
    const room = () => ({ id: 'room', name: '合成群', privacyVersion: version, selfMemberId: 'me', ownerMemberId: 'me', members: [], currentMatch: null });
    const fetchImpl = async url => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/dashboard')) {
        if (version && failReload && !parsed.searchParams.has('after')) return Response.json({ error: 'unavailable' }, { status: 503 });
        return Response.json({ room: room(), messages: { items: Number(parsed.searchParams.get('after') ?? 0) < 1
          ? [{ seq: 1, role: 'user', displayName: version ? '已注销成员' : '旧昵称', text: '共同消息' }] : [], cursor: 1, hasMore: false },
          tasks: { items: [] }, memories: { items: version ? [] : [{ content: '个人偏好哨兵' }] }, budget: {}, connections: {}, confirmations: { items: [] } });
      }
      return Response.json(room());
    };
    let controller, tick;
    if (platform === 'desktop') {
      const stateDir = await mkdtemp(join(tmpdir(), 'team-privacy-'));
      controller = await createTeamBridge({ stateDir, serviceBaseUrl: 'https://example.test', getToken: () => 'fixture', fetchImpl, pollMs: 60000 });
      t.after(async () => { await controller.close(); await rm(stateDir, { recursive: true, force: true }); });
      await controller.command('create', { name: 'test', displayName: 'me' }); tick = () => controller.tick();
    } else {
      const saved = new Map(); controller = createMobileTeamSession({ fetchImpl, accountKey: 'fixture', storage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) } });
      await controller.api('open', { roomId: 'room' }); tick = () => controller.api();
    }
    assert.match(JSON.stringify(controller.view()), /旧昵称/); version = 1; await tick();
    const view = controller.view();
    assert.doesNotMatch(JSON.stringify(view), /旧昵称|个人偏好哨兵/);
    assert.equal(view.room.privacyVersion, 1);
    assert.equal(view.messages.length, fail ? 0 : 1);
    if (!fail) assert.equal(view.messages[0].displayName, '已注销成员');
    if (platform === 'desktop') await controller.close();
  }
});

test('desktop purges the host cache after privacy advances even if message reload fails', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'team-privacy-host-')); let version = 0, removed = 0, stopped = 0;
  const room = () => ({ id: 'room', name: '合成群', privacyVersion: version, selfMemberId: 'me', ownerMemberId: 'me', members: [{ id: 'me' }], currentMatch: null });
  const reference = 'JINBAO_TEAM_HOST_'+createHash('sha256').update('room').digest('hex');
  const saved = new Map([[reference, JSON.stringify({ schemaVersion: 1, deviceId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', deviceSecret: 'S'.repeat(43), proposalId: 'proposal', expiresAt: Date.now()+60000, enabled: true, privacyVersion: 0 })]]);
  const localHost = {
    credentials: { async resolve(key) { return saved.has(key) ? { value: saved.get(key) } : undefined; }, async set(key, value) { saved.set(key, value); }, async unset(key) { saved.delete(key); } },
    cacheStore: { async removeRoom(_room, reason) { assert.equal(reason, 'privacy_changed'); removed++; return true; }, async clearBeforeGrant() { return true; }, status() { return { pending: 0 }; } },
    getConfig: async () => ({}), getKey: async () => 'fixture',
    runnerFactory: async () => ({ async close() { stopped++; } }),
    deviceFactory: () => ({ async start() {}, async stop() { stopped++; } }),
  };
  const fetchImpl = async url => {
    const parsed = new URL(url), path = parsed.pathname;
    if (path.endsWith('/dashboard')) {
      if (version && !parsed.searchParams.has('after')) return Response.json({ error: 'unavailable' }, { status: 503 });
      return Response.json({ room: room(), messages: { items: [{ seq: 1, role: 'user', text: '旧消息' }], cursor: 1, hasMore: false },
        tasks: { items: [] }, memories: { items: [] }, budget: {}, connections: {}, confirmations: { items: [] } });
    }
    if (path.endsWith('/host')) return Response.json({ configured: true, memberId: 'me', executionAvailable: true, proposals: [] });
    return Response.json(room());
  };
  const bridge = await createTeamBridge({ stateDir, serviceBaseUrl: 'https://example.test', getToken: () => 'fixture', fetchImpl, pollMs: 60000, localHost });
  t.after(async () => { await bridge.close(); await rm(stateDir, { recursive: true, force: true }); });
  await bridge.command('create', { name: 'test', displayName: 'me' });
  version = 1; await bridge.tick();
  assert.equal(removed, 1); assert.ok(stopped > 0);
  assert.equal(JSON.parse(saved.get(reference)).privacyVersion, 1);
  assert.equal(bridge.view().messages.length, 0);
});
