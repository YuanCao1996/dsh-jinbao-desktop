import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalRoomRunner } from '../local-runner.mjs';
import { createRoomCacheStore, ROOM_CACHE_MAX_AGE } from '../cache-store.mjs';

const native = { skip: !process.env.JINBAO_TEST_DSH_MODULES, timeout: 30000 };
const reply = (content = '等队友先手控制。', usage = 12) => Response.json({ choices: [{ finish_reason: 'stop', message: { content } }],
  ...(usage === null ? {} : { usage: { total_tokens: usage } }) });
async function fixture(t, extra = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'team-windows-native-'));
  const records = [], requests = [], reads = [];
  let config = { mode: 'byok', baseUrl: 'https://model.example/v1', model: 'fixture' }, key = 'LOCAL-KEY-NEVER-UPLOADED';
  const options = { stateDir, moduleRoot: process.env.JINBAO_TEST_DSH_MODULES, getConfig: async () => config, getKey: async () => key,
    fetchImpl: async (url, request) => { requests.push(JSON.parse(request.body)); assert.equal(url, 'https://model.example/v1/chat/completions'); return reply(); }, ...extra };
  let runner;
  const input = (sessionId = 'game-one', roomId = 'room-one', question = '本人该怎么配合？') => ({
    task: { id: 'task-one', roomId, sessionId, membershipVersion: 1, memoryVersion: 1, reserved: 50000, executionMode: 'byok' },
    turn: { sender: { id: 'member-one' }, current: { game: 'lol', mode: 'KIWI' }, message: { text: question }, mentorInstruction: '导师为柳如风。' },
    signal: new AbortController().signal, reportUsage: async (usage, { known = true } = {}) => { records.push({ usage, known }); },
    tools: { definitions: [{ name: 'get_current_match', description: '读取本局', parameters: { type: 'object', properties: {} } }],
      check: async () => {}, execute: async name => { reads.push(name); return { gold: 1234, member: 'member-one' }; } },
  });
  const open = async () => { runner = await createLocalRoomRunner(options); return runner; };
  t.after(async () => { await runner?.close(); await rm(stateDir, { recursive: true, force: true, maxRetries: 3 }); });
  return { stateDir, records, requests, reads, input, open, options, setConfig: value => { config = value; }, setKey: value => { key = value; } };
}

test('installed Windows DSH executes scoped tools, resumes the game and isolates other rooms and games', native, async t => {
  const c = await fixture(t); let calls = 0;
  c.options.fetchImpl = async (_url, request) => {
    const body = JSON.parse(request.body); c.requests.push(body);
    if (++calls !== 1) return reply();
    return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { content: null, reasoning_content: 'PRIVATE-REASONING',
      tool_calls: [{ id: 'state', type: 'function', function: { name: 'get_current_match', arguments: '{}' } }] } }], usage: { total_tokens: 12 } });
  };
  let runner = await c.open();
  assert.deepEqual(await runner.run(c.input('one', 'room-one', '本局标记 ALPHA')), { text: '等队友先手控制。', usage: 24 });
  assert.deepEqual(c.reads, ['get_current_match']);
  assert.ok(c.requests[1].messages.some(message => message.role === 'tool' && message.tool_call_id === 'state'));
  assert.match(JSON.stringify(c.requests[0]), /海克斯大乱斗|柳如风/);
  assert.doesNotMatch(JSON.stringify(c.requests), /LOCAL-KEY-NEVER-UPLOADED|read_file|inspect_latest_screen|manage_user_memory/);
  await runner.close(); runner = await c.open();
  await runner.run(c.input('one', 'room-one', '本局继续'));
  assert.match(JSON.stringify(c.requests.at(-1)), /ALPHA/);
  await runner.run(c.input('two', 'room-one', '第二局开始'));
  assert.doesNotMatch(JSON.stringify(c.requests.at(-1)), /ALPHA|本局继续/);
  await runner.run(c.input('one', 'room-other', '另一个群'));
  assert.doesNotMatch(JSON.stringify(c.requests.at(-1)), /ALPHA|本局继续|第二局开始/);
  assert.ok(c.records.some(record => record.known === false));
});

test('failed durable usage acknowledgement or revoked tools prevent any provider request', native, async t => {
  const c = await fixture(t), runner = await c.open(), input = c.input();
  input.reportUsage = async (_usage, { known = true } = {}) => { if (!known) throw new Error('fixture-lost-ack'); };
  await assert.rejects(runner.run(input)); assert.equal(c.requests.length, 0);
  const revoked = c.input('another'); revoked.tools.check = async () => { throw new Error('revoked'); };
  await assert.rejects(runner.run(revoked)); assert.equal(c.requests.length, 0);
});

test('missing usage keeps the request uncertain and DSH never silently retries a paid request', native, async t => {
  const c = await fixture(t); let calls = 0;
  c.options.fetchImpl = async () => { calls++; return reply('有回答但没有账单', null); };
  const runner = await c.open(); await assert.rejects(runner.run(c.input()), /local_room_usage_unresolved/);
  assert.equal(calls, 1); assert.equal(c.records.at(-1).known, false);
});

test('failed preflight acknowledgement records a known no-call correction; failed final acknowledgement preserves known usage', native, async t => {
  const c = await fixture(t), runner = await c.open(), first = c.input(), records = [];
  first.reportUsage = async (usage, { known = true } = {}) => { records.push({ usage, known }); if (!known) throw Error('checkpoint-ack-lost'); };
  await assert.rejects(runner.run(first)); assert.equal(c.requests.length, 0); assert.deepEqual(records.at(-1), { usage: 0, known: true });
  const second = c.input('another-session');
  second.reportUsage = async (usage, { known = true } = {}) => { records.push({ usage, known }); if (known && usage === 12) throw Error('final-ack-lost'); };
  await assert.rejects(runner.run(second)); assert.equal(c.requests.length, 1); assert.deepEqual(records.at(-1), { usage: 12, known: true });
});

test('cancellation and local configuration changes stop the installed DSH without late answers', native, async t => {
  const c = await fixture(t); let started, aborted = false;
  const entered = new Promise(resolve => { started = resolve; });
  c.options.fetchImpl = async (_url, request) => { started(); return new Promise((_resolve, reject) => {
    request.signal.addEventListener('abort', () => { aborted = true; reject(request.signal.reason); }, { once: true });
  }); };
  const runner = await c.open(), controller = new AbortController(), input = c.input(); input.signal = controller.signal;
  const task = runner.run(input), rejected = assert.rejects(task); await entered; controller.abort(); await rejected;
  assert.equal(aborted, true); assert.equal(c.records.at(-1).known, false);
  c.setKey('new-key'); c.options.fetchImpl = async () => assert.fail('changed key must require reinitialization');
  await assert.rejects(runner.run(c.input('next')), /local_room_configuration_changed/);
});

test('unapproved tools and an impossible request budget are rejected before any provider call', native, async t => {
  const c = await fixture(t), runner = await c.open(), unsafe = c.input();
  unsafe.tools.definitions.push({ name: 'read_file' }); await assert.rejects(runner.run(unsafe), /invalid_host_job/);
  const small = c.input(); small.task.reserved = 1;
  await assert.rejects(runner.run(small), /local_room_request_budget_exceeded/);
  assert.equal(c.requests.length, 0);
});

test('the BYOK runtime refuses the official service origin before reading a key or loading DSH', async () => {
  let reads = 0;
  await assert.rejects(createLocalRoomRunner({ stateDir: 'unused', getKey: async () => { reads++; },
    getConfig: async () => ({ mode: 'byok', baseUrl: 'https://api.jinbaoai.top/v1', model: 'example' }) }), /local_byok_endpoint_required/);
  assert.equal(reads, 0);
});

test('long game history uses native compaction and keeps its original persisted event log', native, async t => {
  const c = await fixture(t); let compactions = 0;
  c.options.fetchImpl = async (_url, request) => {
    const body = JSON.parse(request.body); c.requests.push(body);
    if (!body.tools?.length) { compactions++; return reply('本局历史已摘要，当前事实请调用群工具。'); }
    return reply('建议等控制再输出。'.repeat(180));
  };
  const runner = await c.open();
  for (let index = 0; index < 15; index++) await runner.run(c.input('long', 'room-one', index ? '继续问' + index : '原始独有标记 ORIGINAL'));
  assert.ok(compactions > 0);
  await runner.close();
  async function history(directory) {
    let text = '';
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) text += await history(path);
      else text += await readFile(path, 'utf8');
    }
    return text;
  }
  assert.match(await history(join(c.stateDir, 'team-host-sessions')), /ORIGINAL/);
  assert.doesNotMatch(await history(join(c.stateDir, 'team-host-sessions')), /LOCAL-KEY-NEVER-UPLOADED/);
});

test('expired cached DSH is disposed before the next task resumes; the first fresh task succeeds with a clean history', native, async t => {
  const c = await fixture(t); let clock = 1000;
  const cache = await createRoomCacheStore({ stateDir: c.stateDir, now: () => clock }); c.options.cacheStore = cache;
  const runner = await c.open();
  try {
    await runner.run(c.input('one', 'room-one', '旧工作缓存标记 OLD-CACHE'));
    clock += ROOM_CACHE_MAX_AGE;
    assert.equal((await runner.run(c.input('one', 'room-one', '新问题'))).text, '等队友先手控制。');
    assert.doesNotMatch(JSON.stringify(c.requests.at(-1)), /OLD-CACHE/);
    assert.equal(c.requests.length, 2);
  } finally { await runner.close(); await cache.close(); }
});

test('a deletion intent aborts a live installed DSH request, then removes files without reopening or publishing them', native, async t => {
  const c = await fixture(t); let started, mode = 'waiting', aborted = false;
  const entered = new Promise(resolve => { started = resolve; });
  const cache = await createRoomCacheStore({ stateDir: c.stateDir }); c.options.cacheStore = cache;
  c.options.fetchImpl = async (_url, request) => {
    c.requests.push(JSON.parse(request.body));
    if (mode !== 'waiting') return reply();
    started(); return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => { aborted = true; reject(request.signal.reason); }, { once: true }));
  };
  const runner = await c.open();
  try {
    const task = runner.run(c.input('one', 'room-one', '未完成的旧请求 PENDING-CACHE')), rejected = assert.rejects(task);
    await entered; assert.equal(await cache.removeRoom('room-one', 'authorization_ended'), false);
    await rejected; assert.equal(aborted, true); await cache.runOnce();
    assert.equal((await cache.receipts()).length, 1);
    mode = 'ready'; await runner.run(c.input('one', 'room-one', '已重新授权'));
    assert.doesNotMatch(JSON.stringify(c.requests.at(-1)), /PENDING-CACHE/);
  } finally { await runner.close(); await cache.close(); }
});

test('concurrent shutdown and cache deletion drain native persistence before marking files deleted', native, async t => {
  const c = await fixture(t), cache = await createRoomCacheStore({ stateDir: c.stateDir }); c.options.cacheStore = cache;
  const runner = await c.open();
  try {
    await runner.run(c.input());
    await Promise.all([runner.close(), cache.removeRoom('room-one', 'access_ended')]);
    await cache.runOnce();
    assert.equal((await cache.receipts()).length, 1);
    assert.equal((await readdir(join(c.stateDir, 'team-host-sessions'))).length, 0);
    await runner.close();
    assert.equal((await readdir(join(c.stateDir, 'team-host-sessions'))).length, 0);
  } finally { await runner.close(); await cache.close(); }
});
