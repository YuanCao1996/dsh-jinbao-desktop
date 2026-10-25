import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createGenericRuntime } from '../runtime.mjs';
import { boardImage } from './pixel-fixture.mjs';
import { createHash } from 'node:crypto';
import { prepareSdkFixture } from './sdk-fixture.mjs';
import { assertSdkSingleton } from '../sdk-check.mjs';

const sdk = await prepareSdkFixture();
after(() => sdk.dispose());
const { Context } = await sdk.load('@deepseek-ai/cordis');
const { createScope, scopeTarget } = await sdk.load('@deepseek-ai/dsh-scope');
const { ToolRuntime, defineTool } = await sdk.load('@deepseek-ai/dsh-tools');
const { SystemPrompt } = await sdk.load('@deepseek-ai/dsh-system-prompt');
const { createDshAnalyzer } = await sdk.module('dsh.mjs');
const { registerGenericTools } = await sdk.module('dsh-tools.mjs');

const id = 'generic-gomoku-12345678-1234-1234-1234-123456789abc';
const context = { game: 'gomoku', session_id: id, revision: 1,
  current_match_state: { state: { cells: [], player_color: 'unknown' } }, user_question: '解释一下棋盘' };

test('mixed SDK composition fails before any scoped/global prompt registration', () => {
  assert.throws(() => assertSdkSingleton({ resolve() { throw new Error('missing-or-mixed-sdk'); } }), /dsh_sdk_instance_mismatch/);
});

function host(script = async call => { await call('generic_reply', { text: '玩家执子尚未确认。' }); }) {
  const ctx = new Context();
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: 'LoL-only-fixture-persona' });
  ctx.systemPrompt.section({ name: 'lol-fixture', order: 0, text: 'LoL-only-fixture-persona' });
  new ToolRuntime(ctx, { mode: 'native' });
  const calls = [];
  let creates = 0, disposed = 0;
  let selected = id;
  const runtime = { status: () => ({ session_id: selected }), state: () => ({ status: 'unknown', game: 'gomoku' }),
    plan: value => ({ plan: value }), observe: async () => ({ status: 'observed' }) };
  const sessions = [];
  const messages = [];
  const openSession = async (_ctx, options) => {
    creates++;
    const agent = { status: 'idle', cancel() { calls.push(['cancel']); } };
    const scope = createScope(ctx, agent);
    await options.setup(scope.ctx);
    const call = async (name, args) => {
      const result = await ctx.tools.execute({ callId: `fixture-${calls.length}`, agent, name,
        arguments: args, signal: new AbortController().signal });
      calls.push([name, result]);
      return result;
    };
    agent.send = async message => {
      messages.push(message);
      const gate = await ctx.waterfall(scopeTarget(agent, agent), 'agent/pre-step',
        { step: 1, messages: [message] }, async () => ({ kind: 'enter' }));
      assert.equal(gate?.kind, 'enter', 'pre-step must call next(), as required by the real DSH driver');
      agent.status = 'running';
      await script(call, { agent, ctx, scope, options });
      agent.status = 'idle';
      ctx.emit(scopeTarget(agent, agent), 'agent/status', { agent, status: 'idle' });
    };
    const value = { agent, dispose: async () => { disposed++; await scope.dispose(); } };
    sessions.push({ agent, scope, call });
    return value;
  };
  const analyzer = createDshAnalyzer(ctx, { enabled: true, runtime, provider: 'fixture-provider',
    model: 'fixture-model', cwd: 'workspace/generic-game', openSession, timeoutMs: 1000 });
  return { ctx, runtime, analyzer, sessions, calls, messages, counts: () => ({ creates, disposed }),
    select(value) { selected = value; } };
}

test('real SDK hides global tools only from generic scope; LoL/root visibility remains unchanged', async () => {
  const h = host(async call => {
    assert.equal((await call('generic_read_state', {})).isError, false);
    assert.equal((await call('shell', {})).isError, true);
    assert.equal((await call('lol_private', {})).isError, true);
    await call('generic_reply', { text: '只读取了授权棋盘，未确认玩家执子。' });
  });
  const definition = name => defineTool({ name, description: name, parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [] }, execute: async () => ({ ok: true }) });
  h.ctx.tools.register(definition('shell'));
  h.ctx.tools.register(definition('lol_private'));
  assert.equal(await h.analyzer.analyze({ system: 'fixture', context }), '只读取了授权棋盘，未确认玩家执子。');
  const agent = h.sessions[0].agent;
  assert.equal(h.ctx.tools.get('shell', agent), undefined);
  assert.equal(h.ctx.tools.get('lol_private', agent), undefined);
  assert.ok(h.ctx.tools.get('shell'));
  assert.ok(h.ctx.tools.get('lol_private'));
  assert.equal(h.ctx.tools.modeFor(agent), 'native');
  assert.equal(h.ctx.tools.get('generic_read_state'), undefined);
  const genericPrompt = await h.ctx.systemPrompt.assemble({ scope: agent });
  assert.equal(genericPrompt.sections.length, 1);
  assert.doesNotMatch(genericPrompt.sections[0].text, /LoL-only-fixture-persona/);
  const existingPrompt = await h.ctx.systemPrompt.assemble({});
  assert.ok(existingPrompt.sections.some(section => section.text.includes('LoL-only-fixture-persona')));
  await h.analyzer.close();
});

test('tool JSON rejects target/session/path overrides; per-turn observation cap and reply length are enforced', async () => {
  const h = host(async call => {
    assert.equal((await call('generic_observe', { target_id: 'lol' })).isError, true);
    assert.equal((await call('generic_observe', {})).isError, false);
    assert.equal((await call('generic_observe', {})).isError, false);
    assert.equal((await call('generic_observe', {})).isError, true);
    assert.equal((await call('generic_reply', { text: '字'.repeat(257) })).isError, true);
    await call('generic_reply', { text: '目前不能确认最佳落子。' });
  });
  assert.equal(await h.analyzer.analyze({ system: 'fixture', context }), '目前不能确认最佳落子。');
  await h.analyzer.close();
});

test('same-session multi-turn uses one Agent and resets per-turn guards, not LoL memory', async () => {
  const h = host();
  for (let i = 0; i < 3; i++) {
    assert.equal(await h.analyzer.analyze({ system: 'fixture', context: { ...context, user_question: `第${i}次问题` } }), '玩家执子尚未确认。');
  }
  assert.equal(h.counts().creates, 1);
  assert.ok(h.messages.every(message => !message.content[0].text.includes('"conversation":')));
  await h.analyzer.close();
  assert.equal(h.counts().disposed, 1);
});

test('missing final reply fails immediately instead of returning a blank success', async () => {
  const h = host(async call => { await call('generic_read_state', {}); });
  await assert.rejects(h.analyzer.analyze({ system: 'fixture', context }), /dsh_final_reply_missing/);
  assert.equal(h.counts().disposed, 1);
});

test('normal direct assistant completion is accepted only after idle, without displaying reasoning', async () => {
  const h = host(async (_call, { agent, ctx }) => {
    ctx.emit(scopeTarget(agent, agent), 'session/event', { id }, { type: 'assistant/message', data: {
      message: { content: [{ type: 'reasoning', text: 'private reasoning' }, { type: 'text', text: '黑子1枚，白子0枚。' }] },
      stream: [{ type: 'chunk', time: 1, chunk: { type: 'finish', reason: { kind: 'stop' } } }],
    } });
  });
  assert.equal(await h.analyzer.analyze({ system: 'fixture', context }), '黑子1枚，白子0枚。');
  assert.equal(await h.analyzer.analyze({ system: 'fixture', context }), '黑子1枚，白子0枚。');
  assert.equal(h.counts().creates, 1);
  await h.analyzer.close();
});

test('truncated, interrupted, foreign, oversized and tool-bearing assistant text is not treated as final', async () => {
  for (const invalid of ['max-tokens', 'interrupted', 'foreign', 'oversized', 'tool-calls']) {
    const h = host(async (_call, { agent, ctx }) => {
      const content = [{ type: 'text', text: invalid === 'oversized' ? '字'.repeat(257) : '未完成正文' }];
      if (invalid === 'tool-calls') content.push({ type: 'tool-call', name: 'generic_read_state', arguments: '{}' });
      ctx.emit(scopeTarget(agent, agent), 'session/event', { id: invalid === 'foreign' ? 'other-session' : id }, {
        type: 'assistant/message', data: { interrupted: invalid === 'interrupted', message: { content },
          stream: [{ type: 'chunk', time: 1, chunk: { type: 'finish', reason: {
            kind: invalid === 'max-tokens' || invalid === 'tool-calls' ? invalid : 'stop' } } }],
        },
      });
    });
    await assert.rejects(h.analyzer.analyze({ system: 'fixture', context }), /dsh_final_reply_missing/);
  }
});

test('provider errors retain safe failure codes rather than being masked as missing final replies', async () => {
  const h = host(async (_call, { agent, ctx }) => {
    await ctx.waterfall(scopeTarget(agent, agent), 'agent/request-error',
      { failure: { code: 'AUTH', message: 'private-upstream-details' } }, async () => undefined);
  });
  await assert.rejects(h.analyzer.analyze({ system: 'fixture', context }), error =>
    error.message === 'dsh_provider_auth' && !error.message.includes('private-upstream'));
});

test('turn timeout disposes its own session; disabled and wrong game never create agents', async () => {
  const off = createDshAnalyzer({}, {});
  await assert.rejects(off.analyze({ context }), /dsh_disabled/);
  const h = host(async () => new Promise(() => {}));
  const short = createDshAnalyzer(h.ctx, { enabled: true, runtime: h.runtime, provider: 'fixture',
    model: 'fixture', cwd: 'workspace/generic-game', timeoutMs: 15,
    openSession: async () => new Promise(() => {}) });
  await assert.rejects(short.analyze({ system: 'fixture', context }), /dsh_timeout/);
  await assert.rejects(h.analyzer.analyze({ system: 'fixture', context: { ...context, game: 'lol' } }), /dsh_game_scope_denied/);
  assert.equal(h.counts().creates, 0);
});

test('only agent-scoped registration is allowed; cannot mask tools globally', () => {
  const ctx = new Context();
  assert.throws(() => registerGenericTools(ctx, { runtime: {}, sessionId: id, request: () => null }), /agent_scope_required/);
});

test('cancel while opening settles immediately; concurrent startup cannot create a second session', async () => {
  const h = host();
  const analyzer = createDshAnalyzer(h.ctx, { enabled: true, runtime: h.runtime, provider: 'fixture',
    model: 'fixture', cwd: 'workspace/generic-game', openSession: async () => new Promise(() => {}) });
  const first = analyzer.analyze({ system: 'fixture', context });
  await assert.rejects(analyzer.analyze({ system: 'fixture', context }), /dsh_busy/);
  await analyzer.close();
  await assert.rejects(first, /dsh_cancelled/);
});

test('raster -> isolated runtime -> real SDK state/plan tools -> final mock reply is one bounded chain', async () => {
  const image = boardImage({ pieces: [{ row: 7, col: 7, color: 'black' }] });
  const h = host(async call => {
    const observed = await call('generic_read_state', {});
    assert.equal(observed.isError, false);
    assert.equal(observed.value.facts.cells[112], 'black');
    assert.equal(observed.value.facts.player_color, 'unknown');
    const planned = await call('generic_plan', { quality: 'standard', interval_ms: 1000, duration_ms: 1000 });
    assert.equal(planned.isError, false);
    assert.equal(planned.value.automatic_observation, false);
    await call('generic_reply', { text: '棋盘中心有一枚黑子；玩家执子和规则还未确认。' });
  });
  const runtime = createGenericRuntime({ enabled: true, specializedActive: async () => false,
    analyze: request => h.analyzer.analyze(request), observer: {
      select: async () => ({ kind: 'window', id: 'fixture', authorized: true, width: 640, height: 640 }), clear() {},
      capture: async () => ({ image, frame: { target_id: 'fixture', width: 640, height: 640,
        captured_at_ms: Date.now(), sha256: createHash('sha256').update(image.rgb).digest('hex'), assistant_excluded: true }, geometry: {} }),
    } });
  await runtime.start({ targetId: 'fixture', authorized: true, game: 'gomoku' });
  h.select(runtime.status().session_id);
  h.runtime.state = () => runtime.state();
  h.runtime.plan = value => runtime.plan(value);
  h.runtime.observe = value => runtime.observe(value);
  await runtime.observe();
  const answer = await runtime.ask('看看这个棋盘');
  assert.equal(answer.status, 'completed');
  assert.equal(answer.text, '棋盘中心有一枚黑子；玩家执子和规则还未确认。');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.counts().creates, 1);
  assert.deepEqual(h.calls.map(value => value[0]), ['generic_read_state', 'generic_plan', 'generic_reply']);
  runtime.stop();
  await h.analyzer.close();
});
