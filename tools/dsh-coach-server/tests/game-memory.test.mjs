import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGameMemory } from '../lib/game-memory.js';
import { dispatchGameChat, buildGameChatMessage } from '../lib/chat-bridge.js';
import { initialOverlayState, createOverlayService } from '../../dsh-onboarding/overlay-state.mjs';

test('full event history paginates beyond the UI window, survives restart and does not cross games', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jinbao-memory-'));
  const memory = createGameMemory(dir), state = { ...initialOverlayState(), game: 'lol', match: 'one', at: 1, me: { champion: '安妮' } };
  for (let i = 0; i < 55; i++) await memory.record(state, { kind: 'chat_events', purchase: [{ item: '装备' + i }], puuid: 'secret-player' }, 'live.jsonl', { key: 'source', offset: i + 1 });
  state.events = [{ time: '03:00', text: '装备购买' }]; state.broadcasts = [{ text: '等队友' }];
  await memory.snapshot(state); await memory.flush();
  const restarted = createGameMemory(dir); let cursor = 0, rows = [];
  do { const page = await restarted.query({ game: 'lol', match: 'one', cursor, limit: 20 }); rows.push(...page.rows); cursor = page.nextCursor; } while (cursor !== null);
  assert.equal(rows.length, 55); assert.doesNotMatch(JSON.stringify(rows), /secret-player|puuid/);
  await restarted.record(state, { kind: 'chat_events' }, 'live.jsonl', { key: 'source', offset: 55 });
  assert.equal((await restarted.query({ game: 'wzry', match: 'one' })).rows.length, 0);
  await assert.rejects(restarted.query({ game: 'lol', match: 'one', cursor: 2 }), /boundary/);
  state.match = 'two'; state.at = 2; await restarted.snapshot(state);
  const context = await restarted.context('lol', 'two');
  assert.equal(context.previousMatches[0].match, 'one');
  assert.equal(context.current.events[0].text, '装备购买');
  assert.equal(context.current.broadcasts[0].text, '等队友');
  assert.equal((await restarted.context('wzry', 'two')).previousMatches.length, 0);
});

test('explicit preferences persist with provenance; tool cannot invent a quote from a log', async () => {
  const memory = createGameMemory(await mkdtemp(join(tmpdir(), 'jinbao-preference-')));
  await assert.rejects(memory.remember('lol', '喜欢前排', '日志说的', '这局出什么？'), /explicit/);
  await memory.remember('lol', '喜欢前排', '我喜欢前排', '记住，我喜欢前排');
  assert.equal((await memory.context('lol', 'new')).preferences[0].origin, 'user');
  assert.equal((await memory.context('wzry', 'new')).preferences.length, 0);
});

test('pre-upgrade original logs are queryable without traversing paths or mixing explicitly tagged games', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jinbao-raw-history-')); await mkdir(join(dir, 'logs'));
  await writeFile(join(dir, 'logs', 'old.jsonl'), [
    { game: 'lol', kind: 'event', text: '升级前购买星蚀' }, { game: 'wzry', text: '另一款游戏' },
  ].map(JSON.stringify).join('\n') + '\n');
  const memory = createGameMemory(dir);
  assert.deepEqual((await memory.query({ game: 'lol', source: '__list__' })).sources, ['old.jsonl']);
  const result = await memory.query({ game: 'lol', source: 'old.jsonl' });
  assert.equal(result.rows.length, 1); assert.equal(result.historicalRaw, true);
  await assert.rejects(memory.query({ game: 'lol', source: '../settings.jsonl' }), /source/);
});

test('native chat reuses exactly the same game/match monitor as automatic coaching and authenticates locally', async () => {
  const calls = [], monitor = { submitInteraction: async (...args) => { calls.push(args); return '可以按以下步骤操作'; } };
  const monitors = { get: (game, match) => { calls.push([game, match]); return monitor; } };
  const req = { headers: { authorization: 'Bearer local-secret' }, socket: { remoteAddress: '127.0.0.1' } };
  const args = { req, body: { game: 'lol', match: 'same-match', question: '如何出装' }, credentials: { resolve: async () => ({ value: 'local-secret' }) }, monitors };
  assert.equal((await dispatchGameChat(args)).answer, '可以按以下步骤操作');
  assert.deepEqual(calls[0], ['lol', 'same-match']); assert.equal(calls[1][2].chat, true);
  await assert.rejects(dispatchGameChat({ ...args, req: { ...req, headers: { authorization: 'Bearer invalid' } } }), error => error.status === 401);
  await assert.rejects(dispatchGameChat({ ...args, req: { ...req, headers: { ...req.headers, origin: 'https://evil.test' } } }), error => error.status === 403);
  assert.match(buildGameChatMessage('问题', {}), /web_search\/web_fetch/);
  assert.match(buildGameChatMessage('问题', {}), /不受自动播报/);
});

test('chat sees persisted critical events, broadcasts and chat history before submitting the native turn', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'jinbao-shared-context-')); await mkdir(join(dir, 'logs'));
  await writeFile(join(dir, 'logs', 'live.jsonl'), [
    { game: 'lol', match: 'live', t: 1000, kind: 'game_start', gameTime: 0 },
    { game: 'lol', match: 'live', t: 2000, kind: 'event', name: 'TurretKilled', time: 30 },
    { game: 'lol', match: 'live', at: 3000, broadcast: '注意防御塔' },
  ].map(JSON.stringify).join('\n') + '\n');
  const memory = createGameMemory(dir); let context;
  const service = await createOverlayService({ stateDir: dir, search: async () => ({ results: [] }), agentChat: async request => {
    context = await memory.context(request.game, request.match); return '稳住';
  } }); t.after(service.close);
  await service.ask('刚才发生什么？');
  assert.match(context.current.events[0].text, /防御塔/);
  assert.equal(context.current.broadcasts[0].text, '注意防御塔');
  assert.equal(context.current.chat.at(-1).text, '刚才发生什么？');
});

test('oversized context remains valid JSON and leaves original history available through tools', async () => {
  const memory = createGameMemory(await mkdtemp(join(tmpdir(), 'jinbao-context-budget-')));
  await memory.snapshot({ ...initialOverlayState(), game: 'lol', match: 'big', at: 1, me: { champion: '安妮', payload: 'x'.repeat(8000) }, broadcasts: Array.from({ length: 100 }, () => ({ text: '大'.repeat(8000) })) });
  const context = await memory.context('lol', 'big');
  assert.ok(JSON.stringify(context).length < 16000);
  assert.equal(JSON.parse(JSON.stringify(context)).current.game, 'lol');
});

test('startup replay cannot overwrite newer facts or erase archived chat summaries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jinbao-memory-replay-'));
  const original = createGameMemory(dir);
  const state = { ...initialOverlayState(), game: 'lol', match: 'replay', at: 20, gameSeconds: 600,
    chat: [{ role: 'user', text: '上一局要记住的问题' }], events: [{ time: '10:00', text: '已购买装备' }] };
  await original.snapshot(state);
  const restarted = createGameMemory(dir);
  await restarted.snapshot({ ...state, at: 10, gameSeconds: 0, events: [], chat: [] });
  assert.equal((await restarted.context('lol', 'replay')).current.gameSeconds, 600);
  await restarted.snapshot({ ...state, chat: [] });
  assert.equal((await restarted.context('lol', 'replay')).current.chat[0].text, '上一局要记住的问题');
});
