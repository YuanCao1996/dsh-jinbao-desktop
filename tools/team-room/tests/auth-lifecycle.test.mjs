import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTeamBridge } from '../bridge.mjs';
import { createMobileTeamSession } from '../mobile-session.mjs';
import { teamAccessLoss } from '../client.mjs';

test('identity loss clears desktop/mobile content, pauses sharing and revalidates the remembered room without pairing again', async t => {
  for (const platform of ['desktop', 'mobile']) for (const ingress of ['poll', 'command']) for (const failure of [
    { status: 401, code: 'login_required' },
    { status: 403, code: 'email_login_refresh_required' },
    { status: 403, code: 'identity_mismatch' },
    { status: 403, code: 'account_deletion_pending' },
    { status: 403, code: 'room_forbidden' },
    { status: 503, code: 'room_unavailable' },
  ]) {
    if (ingress === 'command' && failure.status === 503) continue;
    let at = 100000, denied = false, disables = 0;
    const room = { id: 'room', name: 'room', selfMemberId: 'me', ownerMemberId: 'me', members: [], messageCount: 1 };
    const saved = new Map();
    const fetchImpl = async url => {
      const parsed = new URL(url);
      assert.doesNotMatch(parsed.pathname, /connection-code|connect$|observations|model/);
      if (denied) return Response.json({ error: failure.code }, { status: failure.status });
      if (parsed.pathname.endsWith('/dashboard')) return Response.json({ room,
        messages: { items: Number(parsed.searchParams.get('after')) >= 1 ? [] : [{ seq: 1, role: 'assistant', text: 'private-group-text' }], cursor: 1, hasMore: false },
        tasks: { items: [{ status: 'queued' }] }, memories: { items: [{ content: 'private-memory' }] }, budget: { remaining: 100 }, connections: { items: [] }, confirmations: { items: [] } });
      return Response.json(room);
    };
    let controller, refresh, storedRoom;
    if (platform === 'desktop') {
      const stateDir = await mkdtemp(join(tmpdir(), 'team-auth-life-'));
      t.after(() => rm(stateDir, { recursive: true, force: true }));
      controller = await createTeamBridge({ stateDir, serviceBaseUrl: 'https://example.test', getToken: () => 'fixture', fetchImpl, now: () => at, pollMs: 60000 });
      t.after(() => controller.close());
      await controller.command('open', { roomId: 'room' });
      refresh = () => controller.tick();
      storedRoom = async () => JSON.parse(await readFile(join(stateDir, 'team-room-settings.json'), 'utf8')).activeRoomId;
    } else {
      controller = createMobileTeamSession({ fetchImpl, accountKey: 'fixture', now: () => at,
        storage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
        collection: { api: async (action, data) => {
          if (action === 'sharing' && !data.enabled) disables++;
          return { available: true, enabled: false, state: 'not_shared' };
        } } });
      await controller.api('open', { roomId: 'room' }); refresh = () => controller.api();
      storedRoom = async () => JSON.parse([...saved.values()][0]).roomId;
    }
    assert.equal(controller.view().messages.length, 1);
    denied = true;
    if (ingress === 'poll') await refresh();
    else await assert.rejects(platform === 'desktop' ? controller.command('history', {})
      : controller.api('ask-existing', { messageSeq: 1 }), { code: failure.code });
    const lost = teamAccessLoss(failure), view = controller.view();
    assert.equal(view.connected, false);
    if (lost) {
      assert.equal(view.room, null); assert.deepEqual(view.messages, []); assert.deepEqual(view.memories, []);
      assert.deepEqual(view.tasks, []); assert.equal(view.budget, null); assert.equal(view.host, null); assert.equal(view.shareGameInfo, false);
      if (platform === 'mobile') assert.ok(disables >= 1);
    } else assert.equal(view.messages[0].text, 'private-group-text', 'temporary service failure is not revocation');
    assert.equal(await storedRoom(), lost === 'membership' ? null : 'room');
    denied = false; at += 31000; await refresh();
    if (lost !== 'membership') {
      assert.equal(controller.view().connected, true); assert.equal(controller.view().messages.length, 1);
      if (lost) assert.equal(controller.view().shareGameInfo, false);
    } else assert.equal(controller.view().room, null);
    if (platform === 'desktop') await controller.close();
  }
});

test('an in-flight desktop dashboard cannot restore private content after a command reports authentication loss', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'team-auth-race-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let hold = false, release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const room = { id: 'room', members: [], messageCount: 1 };
  const dashboard = () => Response.json({ room, messages: { items: [{ seq: 1, text: 'private-history', role: 'assistant' }], cursor: 1, hasMore: false },
    tasks: { items: [] }, memories: { items: [] }, budget: {}, connections: {}, confirmations: { items: [] } });
  const controller = await createTeamBridge({ stateDir, serviceBaseUrl: 'https://example.test', getToken: () => 'fixture', pollMs: 60000,
    fetchImpl: async url => {
      const path = new URL(url).pathname;
      if (path.endsWith('/dashboard')) {
        if (hold) { started(); await new Promise(resolve => { release = resolve; }); }
        return dashboard();
      }
      if (hold && path.endsWith('/messages')) return Response.json({ error: 'login_required' }, { status: 401 });
      return Response.json(room);
    } });
  t.after(() => controller.close());
  await controller.command('open', { roomId: 'room' }); assert.equal(controller.view().messages.length, 1);
  hold = true; const pending = controller.tick(); await ready;
  await assert.rejects(controller.command('history', {}), { code: 'login_required' });
  assert.equal(controller.view().room, null); release(); await pending;
  assert.equal(controller.view().room, null); assert.deepEqual(controller.view().messages, []);
  assert.match(controller.view().error, /登录已失效/);
  const overlay = await readFile(join(stateDir, 'team-room-overlay.json'), 'utf8');
  assert.doesNotMatch(overlay, /private-history/);
  await controller.close();
});

test('phone host-status authentication failure is not swallowed and failed native disable is retried after restart', async () => {
  const saved = new Map(); let denyHost = false, failDisable = false, enabled = false, disables = 0;
  const options = { accountKey: 'fixture', storage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    fetchImpl: async url => {
      if (String(url).endsWith('/host')) return denyHost ? Response.json({ error: 'verified_login_required' }, { status: 403 }) : Response.json({});
      return Response.json({ room: { id: 'room', executionHost: { executionAvailable: true } }, messages: { items: [], cursor: 0, hasMore: false },
        tasks: { items: [] }, memories: { items: [] }, budget: {}, connections: {}, confirmations: { items: [] } });
    }, collection: { api: async (action, data) => {
      if (action === 'sharing') {
        if (!data.enabled) { disables++; if (failDisable) throw Error('native-unavailable'); }
        enabled = data.enabled;
      }
      return { available: true, enabled, state: enabled ? 'sharing' : 'not_shared' };
    } } };
  // Restore an existing selection; no server identity or pairing is fabricated.
  saved.set('jinbao-team:fixture', JSON.stringify({ roomId: 'room' }));
  let session = createMobileTeamSession(options); await session.api();
  await session.api('sharing', { enabled: true }); assert.equal(session.view().shareGameInfo, true);
  denyHost = true; failDisable = true; await session.api();
  assert.equal(session.view().room, null); assert.equal(session.view().host, null);
  assert.equal(JSON.parse(saved.get('jinbao-team:fixture')).sharingPaused, true);
  await assert.rejects(session.api('sharing', { enabled: true }), /恢复登录/);
  denyHost = false; session = createMobileTeamSession(options); await session.api();
  assert.equal(session.view().connected, true); assert.equal(session.view().shareGameInfo, false);
  failDisable = false; await session.api(); assert.equal(enabled, false); assert.ok(disables >= 3);
  await session.api('sharing', { enabled: true }); assert.equal(session.view().shareGameInfo, true);
});
