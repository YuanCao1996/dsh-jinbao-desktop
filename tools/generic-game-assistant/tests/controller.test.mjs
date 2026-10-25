import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createGenericController } from '../controller.mjs';
import { gomoku } from '../adapters/gomoku/index.mjs';

const target = { kind: 'window', id: 'fixture-window', authorized: true, width: 1920, height: 1080 };
function board(patch = {}) {
  return { board_size: 15, cells: Array(225).fill('empty'), turn: 'black',
    player_color: 'black', rules: 'freestyle', ...patch };
}
function harness(options = {}) {
  let time = 10000;
  const events = [];
  const controller = createGenericController({ enabled: true, wallNow: () => time,
    now: () => time, log: event => events.push(event), ...options });
  const start = controller.start({ game: 'gomoku', target });
  const ingest = (state = board(), patch = {}) => controller.ingest({ session_id: start.session_id,
    state, frame: { target_id: target.id, width: 960, height: 540, captured_at_ms: time,
      sha256: 'a'.repeat(64), assistant_excluded: true, ...patch } });
  return { controller, events, ingest, start, advance(ms = 1) { time += ms; } };
}

test('default-off creates no session, capture, logging or model traffic', async () => {
  let calls = 0;
  const controller = createGenericController({ analyze: () => { calls += 1; }, log: () => { calls += 1; } });
  assert.equal(controller.start({ game: 'gomoku', target }).status, 'disabled');
  assert.equal(controller.observationPlan().status, 'disabled');
  assert.equal((await controller.explain('你好')).status, 'disabled');
  assert.equal(calls, 0);
  assert.equal(controller.status().session_id, null);
});

test('unknown, lol and wzry cannot fall through into this controller', () => {
  const controller = createGenericController({ enabled: true });
  for (const game of ['lol', 'wzry', 'doudizhu', '../lol', '', undefined]) {
    assert.throws(() => controller.start({ game, target }), /unsupported_generic_game/);
  }
  assert.equal(controller.status().session_id, null);
});

test('structural board normalization retains unknowns and never claims rule or engine validation', () => {
  const cells = Array(225).fill('empty');
  cells[0] = 'unknown';
  const state = gomoku.normalize(board({ cells }));
  assert.equal(state.complete, false);
  assert.equal(state.cells[0], 'unknown');
  assert.equal(state.rules_validation, 'not_performed');
  assert.equal(state.engine_status, 'not_connected');
  for (const value of [board({ cells: [] }), board({ board_size: 8 }), board({ turn: 'red' }),
    board({ rules: 'made_up' }), board({ cells: Array(225).fill('rock') })]) {
    assert.throws(() => gomoku.normalize(value));
  }
});

test('same board refreshes capture time without changing revision; turn, identity and rules change the hash', () => {
  const h = harness();
  assert.equal(h.ingest().revision, 1);
  h.advance();
  assert.equal(h.ingest().changed, false);
  assert.equal(h.controller.status().revision, 1);
  for (const patch of [{ turn: 'white' }, { player_color: 'white' }, { rules: 'renju' }]) {
    h.advance();
    assert.equal(h.ingest(board(patch)).changed, true);
  }
});

test('late observation cannot overwrite newer board; foreign session cannot clear valid state', () => {
  const h = harness();
  h.ingest();
  assert.equal(h.ingest().reason, 'observation_out_of_order');
  assert.equal(h.controller.ingest({ session_id: 'lol-match', frame: null, state: null }).reason, 'session_changed');
  assert.equal(h.controller.status().snapshot.state.complete, true);
});

test('rejected observation invalidates old facts instead of continuing to treat them as current', async () => {
  const h = harness({ analyze: async () => '不能猜测未知格子。' });
  h.ingest();
  h.advance();
  assert.equal(h.ingest(board(), { assistant_excluded: false }).reason, 'assistant_not_excluded');
  assert.equal(h.controller.status().snapshot, null);
  assert.equal((await h.controller.explain('轮到谁')).reason, 'observation_incomplete');
});

test('structured model context includes isolated facts and history, not LoL persona or other match facts', async () => {
  const requests = [];
  const h = harness({ analyze: async request => { requests.push(request); return '当前观察是黑方回合。'; } });
  h.ingest();
  assert.equal((await h.controller.explain('轮到谁')).text, '当前观察是黑方回合。');
  assert.equal(requests[0].context.game, 'gomoku');
  assert.ok(requests[0].context.session_id.startsWith('generic-gomoku-'));
  assert.equal(requests[0].context.capabilities.move_search, false);
  assert.equal(requests[0].context.conversation.length, 0);
  h.advance(10000);
  h.ingest();
  await h.controller.explain('我执什么颜色');
  assert.equal(requests[1].context.conversation.length, 2);
  h.controller.start({ game: 'gomoku', target });
  assert.equal(h.controller.status().snapshot, null);
  assert.ok(h.events.every(event => event.module === 'generic-game-assistant'));
});

test('no automatic model requests on ingest or empty questions; incomplete and stale observations skip', async () => {
  let calls = 0;
  const h = harness({ analyze: async () => { calls += 1; return '观察结果'; } });
  h.ingest();
  assert.equal(calls, 0);
  assert.equal((await h.controller.explain()).reason, 'user_question_required');
  h.advance(5001);
  assert.equal((await h.controller.explain('看棋盘')).reason, 'observation_stale');
  h.ingest(board({ rules: 'unknown' }));
  assert.equal((await h.controller.explain('看棋盘')).reason, 'observation_incomplete');
  assert.equal(calls, 0);
});

test('pending call is single-flight; changing board aborts and suppresses the old reply', async () => {
  let signal;
  const h = harness({ analyze: async request => { signal = request.signal; return new Promise(() => {}); } });
  h.ingest();
  const first = h.controller.explain('分析一下');
  await Promise.resolve();
  assert.equal((await h.controller.explain('再分析')).reason, 'analysis_busy');
  const cells = board().cells;
  cells[112] = 'black';
  h.advance();
  h.ingest(board({ cells, turn: 'white' }));
  assert.equal(signal.aborted, true);
  assert.equal((await first).status, 'discarded');
  assert.equal(h.controller.status().busy, false);
});

test('switching target immediately cancels the old task even if provider ignores cancellation', async () => {
  const h = harness({ analyze: () => new Promise(() => {}) });
  h.ingest();
  const old = h.controller.explain('上一局');
  h.controller.start({ game: 'gomoku', target: { ...target, id: 'new-window' } });
  assert.equal((await old).status, 'discarded');
  assert.equal(h.controller.status().snapshot, null);
  assert.equal(h.controller.status().busy, false);
});

test('bounded timeout releases a hung provider and consumes budget without endless retries', async () => {
  const h = harness({ analysisTimeoutMs: 15, policyOptions: { maxCloudCalls: 1 },
    analyze: () => new Promise(() => {}) });
  h.ingest();
  assert.equal((await h.controller.explain('你好')).reason, 'analysis_timeout');
  assert.equal(h.controller.status().busy, false);
  h.advance(10000);
  h.ingest();
  assert.equal((await h.controller.explain('重试')).reason, 'cloud_budget_exhausted');
});

test('refreshing unchanged board allows a slower reply; stale and oversized replies are not displayed', async () => {
  let resolve;
  const h = harness({ analyze: () => new Promise(done => { resolve = done; }) });
  h.ingest();
  const response = h.controller.explain('我是什么颜色');
  await Promise.resolve();
  h.advance(6000);
  h.ingest();
  resolve('你执黑。');
  assert.equal((await response).status, 'completed');
  h.advance(10000);
  h.ingest();
  const next = h.controller.explain('棋盘呢');
  await Promise.resolve();
  h.advance(5001);
  resolve('旧棋盘');
  assert.equal((await next).status, 'discarded');
  const large = harness({ analyze: async () => '字'.repeat(257) });
  large.ingest();
  assert.equal((await large.controller.explain('太长')).reason, 'analysis_reply_too_long');
});

test('diagnostic sink failure does not stop recognition; snapshots and requests cannot mutate owned state', async () => {
  const h = harness({ log() { throw new Error('disk_full'); }, analyze: async request => {
    request.context.current_match_state.state.cells[0] = 'white';
    return '观察结果';
  } });
  assert.equal(h.ingest().status, 'accepted');
  h.controller.status().snapshot.state.cells[0] = 'black';
  await h.controller.explain('观察');
  assert.equal(h.controller.status().snapshot.state.cells[0], 'empty');
});

test('standalone code has no LoL imports and is not registered in existing startup or release list', async () => {
  const root = new URL('../../../', import.meta.url);
  for (const path of ['tools/jinbao-launcher/main.mjs', 'tools/jinbao-launcher/supervisor.mjs',
    'tools/desktop-release/build.mjs', 'tools/dsh-coach-server/lib/index.js']) {
    const source = await readFile(new URL(path, root), 'utf8');
    assert.doesNotMatch(source, /generic-game-assistant|game-observation/);
  }
  const controller = await readFile(new URL('../controller.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(controller, /lol-companion|dsh-coach-server|setInterval|watchDir/);
});
