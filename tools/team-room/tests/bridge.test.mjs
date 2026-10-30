import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamBridge } from '../bridge.mjs';
test('desktop bridge writes final-only group view, remembers room and avoids repost after budget denial', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'team-bridge-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const messages = [], requests = []; let taskError = 'room_budget_required';
  const room = { id: 'room-1', name: '队伍', selfMemberId: 'member-1', ownerMemberId: 'member-1', members: [{ id: 'member-1', displayName: '队长' }], messageCount: 0, currentMatch: null };
  const options = { stateDir, serviceBaseUrl: 'https://example.test', getToken: () => 'private-auth-token', pollMs: 60_000,
    fetchImpl: async (url, request) => {
      const path = new URL(url).pathname; requests.push({ path, request });
      if (path.endsWith('/dashboard')) return Response.json({ room, messages: { items: messages.filter(message => message.seq > Number(new URL(url).searchParams.get('after') ?? 0)), cursor: messages.length, hasMore: false },
        tasks: { items: [] }, memories: { items: [] }, budget: { authorized: false, remaining: 0 }, connections: { items: [] }, confirmations: { items: [] } });
      if (path.endsWith('/tasks') && request.method === 'POST') return Response.json({ error: taskError }, { status: 403 });
      if (path.endsWith('/messages') && request.method === 'POST') {
        const input = JSON.parse(request.body), message = { ...input, role: 'user', displayName: '队长', memberId: 'member-1', seq: messages.length + 1 };
        messages.push(message); room.messageCount++; return Response.json({ message, duplicate: false });
      }
      if (path.endsWith('/messages')) return Response.json({ items: messages, cursor: messages.length, hasMore: false });
      if (path.endsWith('/tasks') || path.endsWith('/memories')) return Response.json({ items: [] });
      if (path.endsWith('/budget')) return Response.json({ authorized: false, remaining: 0 });
      return Response.json(room);
    } };
  let bridge = await createTeamBridge(options);
  await bridge.command('create', { name: '队伍', displayName: '队长' });
  const result = await bridge.command('send', { text: '@金宝出装', clientMessageId: 'message-1' });
  assert.equal(result.admission.accepted, false);
  assert.equal(messages.length, 1);
  const view = JSON.parse(await readFile(join(stateDir, 'team-room-overlay.json'), 'utf8'));
  assert.equal(view.mode, 'team'); assert.equal(view.chatRows[0].displayName, '队长');
  assert.match(view.status, /群主尚未授权/);
  taskError = 'room_privacy_cleanup_pending';
  const blocked = await bridge.command('send', { text: '@金宝还有问题', clientMessageId: 'message-2' });
  assert.equal(blocked.admission.accepted, false); assert.match(blocked.admission.message, /消息已发出.*正在处理数据/);
  assert.equal(JSON.stringify(view).includes('private-auth-token'), false);
  await Promise.all([bridge.tick(), bridge.command('mode', { mode: 'personal' })]);
  await bridge.close();
  bridge = await createTeamBridge(options);
  await bridge.tick();
  assert.equal(bridge.view().room.id, 'room-1');
  assert.equal(bridge.view().mode, 'personal');
  await bridge.close();
  assert.equal(JSON.parse(await readFile(join(stateDir, 'team-room-overlay.json'), 'utf8')).supported, false);
  assert.equal(requests.filter(row => row.path.endsWith('/messages') && row.request.method === 'POST').length, 2);
});

test('overlay receives readable terminal task feedback without raw errors or stale failure after completion', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'team-feedback-'));
  let bridge;
  t.after(async () => { await bridge?.close(); await rm(stateDir, { recursive: true, force: true }); });
  const room = { id: 'room-feedback', selfMemberId: 'owner', ownerMemberId: 'owner', members: [{ id: 'owner', displayName: '群主' }], currentMatch: null };
  let tasks = [{ id: 'one', status: 'failed', error: 'private-provider-error', createdAt: 1000 }];
  const budget = { authorized: true, remaining: 50000, spent: 0, reserved: 0 };
  bridge = await createTeamBridge({ stateDir, serviceBaseUrl: 'https://example.test', getToken: () => 'fixture', pollMs: 60000, now: () => 2000,
    fetchImpl: async url => new URL(url).pathname.endsWith('/dashboard')
      ? Response.json({ room, messages: { items: [], cursor: 0, hasMore: false }, tasks: { items: tasks }, budget,
        memories: { items: [] }, connections: { items: [] }, confirmations: { items: [] } }) : Response.json(room) });
  const status = async () => JSON.parse(await readFile(join(stateDir, 'team-room-overlay.json'), 'utf8')).status;
  await bridge.command('create', { name: '回放', displayName: '群主' });
  assert.match(await status(), /未生成有效回答/); assert.doesNotMatch(await status(), /private-provider/);
  tasks = [{ ...tasks[0], status: 'cancelled', error: 'context_changed' }]; await bridge.tick();
  assert.match(await status(), /旧回答未发布/);
  tasks = [{ ...tasks[0], status: 'completed' }]; await bridge.tick(); assert.equal(await status(), '');
  tasks = []; budget.pendingReconciliations = 1; await bridge.tick();
  assert.match(await status(), /用量待核对.*普通聊天/);
});
