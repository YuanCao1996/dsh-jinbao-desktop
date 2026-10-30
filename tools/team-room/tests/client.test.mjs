import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeamClient,updateAdviceStatuses,adviceStatusLabel } from '../client.mjs';

test('dashboard cycles bounded cached history, resets on room/cache changes and tolerates an older server', async () => {
  const requested = [];
  let legacy = false, stuck = false;
  const client = createTeamClient({ serviceBaseUrl: 'https://example.test', getToken: () => 'fixture', fetchImpl: async url => {
    const params = new URL(url).searchParams, after = Number(params.get('adviceAfter'));
    requested.push({ path: new URL(url).pathname, after: params.get('adviceAfter'), messagesAfter: params.get('after') });
    return Response.json(legacy ? {} : { adviceCursor: after + (stuck ? 0 : 100), adviceHasMore: after + 100 < 500 });
  } });
  const rows = Array.from({ length: 500 }, (_, i) => ({ seq: i + 1 }));
  for (let i = 0; i < 6; i++) await client.dashboard('room', 500, rows);
  assert.deepEqual(requested.map(row => row.after), ['0', '100', '200', '300', '400', '0']);
  assert.ok(requested.every(row => row.messagesAfter === '500'));
  await client.dashboard('other-room', 500, rows); assert.equal(requested.at(-1).after, '0');
  await client.dashboard('other-room', 900, [{ seq: 850 }, { seq: 900 }]); assert.equal(requested.at(-1).after, '849');
  legacy = true;
  await client.dashboard('room', 500, rows); await client.dashboard('room', 500, rows); assert.equal(requested.at(-1).after, '0');
  legacy = false; stuck = true;
  await client.dashboard('room', 500, rows); await client.dashboard('room', 500, rows); assert.equal(requested.at(-1).after, '0');
  await client.dashboard('room'); assert.equal(requested.at(-1).after, null);
  const changed = updateAdviceStatuses(rows.map(row => ({ ...row, role: 'assistant', adviceStatus: 'current' })),
    rows.slice(0, 100).map(row => ({ seq: row.seq, adviceStatus: 'context_changed' })), {});
  assert.equal(changed[99].adviceStatus, 'context_changed');
});

test('older gateway query rejection falls back once without swallowing authentication failures', async () => {
  const queries = [];
  const client = createTeamClient({ serviceBaseUrl: 'https://example.test', getToken: () => 'fixture', fetchImpl: async url => {
    const query = new URL(url).searchParams; queries.push(query.has('adviceAfter'));
    return query.has('adviceAfter') ? Response.json({ error: 'invalid_query' }, { status: 400 }) : Response.json({});
  } });
  await client.dashboard('room', 1, [{ seq: 1 }]); await client.dashboard('room', 1, [{ seq: 1 }]);
  assert.deepEqual(queries, [true, false, false]);
  let calls = 0;
  const denied = createTeamClient({ serviceBaseUrl: 'https://example.test', getToken: () => 'fixture', fetchImpl: async () => {
    calls++; return Response.json({ error: 'room_forbidden' }, { status: 403 });
  } });
  await assert.rejects(denied.dashboard('room', 1, [{ seq: 1 }]), { code: 'room_forbidden' }); assert.equal(calls, 1);
});

test('cached advice gets changed/previous-match labels without rewriting text or turning user chat into advice',()=>{
 const room={currentMatch:{id:'now'}},rows=[{seq:1,role:'assistant',text:'原建议',roomMatchId:'now',adviceStatus:'current'},
  {seq:2,role:'user',text:'原话'},{seq:3,role:'assistant',text:'旧局',roomMatchId:'old',adviceStatus:'current'}];
 const updated=updateAdviceStatuses(rows,[{seq:1,adviceStatus:'context_changed'},{seq:2,adviceStatus:'context_changed'},{seq:3,adviceStatus:'unknown'}],room);
 assert.equal(updated[0].text,'原建议');assert.match(adviceStatusLabel(updated[0]),/已变化或过期/);assert.equal(adviceStatusLabel(updated[1]),'');
 assert.equal(updated[2].adviceStatus,'previous_match');assert.match(adviceStatusLabel(updated[2]),/旧对局/);assert.equal(rows[0].adviceStatus,'current');
 assert.equal(adviceStatusLabel({role:'assistant',text:'无证据旧消息'}),'');
});
test('team client uses auth headers and final-message protocol without role or actor overrides', async () => {
  const requests = [];
  const client = createTeamClient({ serviceBaseUrl: 'https://example.test', getToken: async () => 'test-token',
    fetchImpl: async (url, options) => { requests.push({ url: String(url), ...options }); return Response.json({ accepted: true }); } });
  await client.send('room-1', { clientMessageId: 'msg-1', text: '@金宝 出装', ask: true, memberId: 'spoof' });
  assert.equal(requests[0].headers.Authorization, 'Bearer test-token');
  assert.deepEqual(JSON.parse(requests[0].body), { clientMessageId: 'msg-1', text: '@金宝 出装', replyTo: null, trigger: 'ask' });
  assert.equal(requests[0].url.includes('token'), false);
});
test('team client rejects unsafe endpoints and surfaces refresh/budget errors', async () => {
  assert.throws(() => createTeamClient({ serviceBaseUrl: 'http://example.test', getToken: () => '' }));
  const client = createTeamClient({ serviceBaseUrl: 'https://example.test', getToken: () => 'token',
    fetchImpl: async () => Response.json({ error: 'email_login_refresh_required' }, { status: 403 }) });
  await assert.rejects(() => client.list(), error => error.code === 'email_login_refresh_required');
  assert.throws(() => client.get('../escape'), error => error.code === 'invalid_room');
});

test('memory paging encodes the keyword and only forwards scoped search options', async () => {
  let sent;
  const client = createTeamClient({ serviceBaseUrl: 'https://example.test', getToken: () => 'fixture',
    fetchImpl: async url => { sent = new URL(url); return Response.json({ items: [], memoryVersion: 7, cursor: 30, hasMore: true }); } });
  const page = await client.memories('room', '打野&pending=false', true, { cursor: 10, memoryVersion: 7, type: 'preference', limit: 20, principal: 'spoof' });
  assert.equal(sent.searchParams.get('query'), '打野&pending=false'); assert.equal(sent.searchParams.get('pending'), 'true');
  assert.equal(sent.searchParams.get('cursor'), '10'); assert.equal(sent.searchParams.get('principal'), null);
  assert.equal(page.memoryVersion, 7); assert.equal(page.hasMore, true);
});

test('host metadata projects safe fields even if an upstream response accidentally contains device secrets', async () => {
  const client = createTeamClient({ serviceBaseUrl: 'https://example.test', getToken: () => 'fixture', fetchImpl: async () => Response.json({
    configured: true, online: true, deviceName: '电脑', deviceSecret: 'must-not-enter-ui', secretHash: 'private', principal: 'private',
    proposals: [{ id: 'proposal-one', deviceName: '电脑', maxTokens: 50000, expiresAt: 1234567, deviceSecret: 'must-not-enter-ui' }] }) });
  const state = await client.hostStatus('room-one');
  assert.equal(state.configured, true); assert.equal(state.proposals.length, 1);
  assert.doesNotMatch(JSON.stringify(state), /deviceSecret|secretHash|principal|must-not-enter-ui|private/);
});
