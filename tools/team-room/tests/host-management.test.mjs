import test from 'node:test';
import assert from 'node:assert/strict';
import { createMobileTeamSession } from '../mobile-session.mjs';

test('a phone manages host metadata and explicit routes without receiving device proofs or uploading a model key', async () => {
  const saved = new Map([['jinbao-team:phone-account', JSON.stringify({ roomId: 'room-one' })]]), requests = [];
  const room = { id: 'room-one', selfMemberId: 'owner', ownerMemberId: 'owner', executionMode: 'official',
    executionHost: { executionAvailable: true }, members: [{ id: 'owner' }] };
  const session = createMobileTeamSession({ accountKey: 'phone-account',
    storage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    fetchImpl: async (url, options) => {
      requests.push({ path: new URL(url).pathname, body: options.body ? JSON.parse(options.body) : null });
      const path = new URL(url).pathname;
      if (path.endsWith('/dashboard')) return Response.json({ room, messages: { items: [], hasMore: false },
        tasks: { items: [] }, budget: {}, memories: { items: [] }, connections: {}, confirmations: { items: [] } });
      if (path.endsWith('/host')) return Response.json({ configured: false, executionAvailable: true, canApprove: true,
        proposals: [{ id: 'proposal-one', deviceName: '队友电脑', maxTokens: 100000 }] });
      return Response.json({ accepted: true });
    } });
  const state = await session.api();
  assert.equal(state.host.canApprove, true); assert.equal(state.host.local, undefined);
  await session.api('host-approve', { proposalId: 'proposal-one', deviceSecret: 'forbidden' });
  await session.api('execution-mode', { mode: 'byok', apiKey: 'forbidden' });
  await session.api('host-revoke');
  assert.deepEqual(requests.slice(-3).map(request => request.body), [{ proposalId: 'proposal-one' }, { executionMode: 'byok' }, {}]);
  await assert.rejects(session.api('host-propose', { deviceName: 'phone', maxTokens: 50000 }));
  assert.doesNotMatch(JSON.stringify([...saved.values(), requests, state]), /deviceSecret|apiKey|forbidden|host-acquire|host-poll/);
});

test('phone explains a saved message when group model admission is temporarily paused', async () => {
  const saved = new Map([['jinbao-team:fixture', JSON.stringify({ roomId: 'room-one' })]]);
  const session = createMobileTeamSession({ accountKey: 'fixture', storage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/messages') && options.method === 'POST') return Response.json({ message: { seq: 1, trigger: 'ask' } });
      if (path.endsWith('/tasks') && options.method === 'POST') return Response.json({ error: 'room_privacy_cleanup_pending' }, { status: 409 });
      return Response.json({});
    } });
  const result = await session.api('send', { text: '@金宝 帮我看看', clientMessageId: 'one' });
  assert.equal(result.admission.accepted, false);
  assert.match(result.admission.message, /消息已发出.*正在处理数据/);
});
