import test from 'node:test';
import assert from 'node:assert/strict';
import { createGenericRuntime } from '../runtime.mjs';
import { boardImage } from './pixel-fixture.mjs';
import { createHash } from 'node:crypto';

function harness(options = {}) {
  let at = 10000;
  let calls = 0;
  let active = false;
  let fail = false;
  const image = boardImage();
  const observer = {
    async select() { return { kind: 'window', id: 'fixture', authorized: true, width: 640, height: 640 }; },
    clear() {},
    async capture() {
      calls++;
      if (fail) throw new Error('target_not_foreground');
      return { frame: { target_id: 'fixture', width: 640, height: 640, captured_at_ms: at,
        assistant_excluded: true, sha256: createHash('sha256').update(image.rgb).digest('hex') },
        image, geometry: { width: 640, height: 640 } };
    },
  };
  const events = [];
  const runtime = createGenericRuntime({ enabled: true, observer, wallNow: () => at, now: () => at,
    specializedActive: async () => active, log: value => events.push(value), ...options });
  return { runtime, events, calls: () => calls, advance(ms) { at += ms; },
    active(value) { active = value; }, fail(value) { fail = value; } };
}

test('default-off runtime starts no windows, timer or DSH call', async () => {
  let calls = 0;
  const runtime = createGenericRuntime({ observer: { select() { calls++; } }, setTimer() { calls++; } });
  assert.equal((await runtime.start()).status, 'disabled');
  assert.equal((await runtime.observe()).status, 'disabled');
  assert.equal(calls, 0);
});

test('specialized game activity must be explicitly checked and blocks generic capture', async () => {
  const unchecked = harness({ specializedActive: undefined });
  await assert.rejects(unchecked.runtime.start({ targetId: 'fixture', authorized: true }), /specialized_activity_not_checked/);
  const h = harness();
  h.active(true);
  await assert.rejects(h.runtime.start({ targetId: 'fixture', authorized: true }), /specialized_game_active/);
  assert.equal(h.calls(), 0);
  h.active(false);
  await h.runtime.start({ targetId: 'fixture', authorized: true });
  h.active(true);
  assert.equal((await h.runtime.observe()).reason, 'specialized_game_active');
  assert.equal(h.calls(), 0);
});

test('actual raster observation is cached, unknown identity remains unknown, cadence rejects immediate recapture', async () => {
  const h = harness();
  await h.runtime.start({ targetId: 'fixture', authorized: true, game: 'gomoku' });
  assert.equal((await h.runtime.observe()).status, 'observed');
  const first = h.runtime.state();
  assert.equal(first.facts.cells.length, 225);
  assert.equal(first.facts.player_color, 'unknown');
  assert.equal((await h.runtime.observe()).reason, 'observation_cooldown');
  h.advance(1000);
  assert.equal((await h.runtime.observe()).changed, false);
  assert.equal(h.runtime.state().revision, first.revision);
  assert.equal(h.calls(), 2);
});

test('capture failure invalidates previous facts and old observations expire rather than becoming current', async () => {
  const h = harness();
  await h.runtime.start({ targetId: 'fixture', authorized: true });
  await h.runtime.observe();
  h.advance(6000);
  assert.equal(h.runtime.state().status, 'unknown');
  assert.equal(h.runtime.state().facts, null);
  h.fail(true);
  assert.equal((await h.runtime.observe()).reason, 'target_not_foreground');
  assert.equal(h.runtime.state().facts, null);
});

test('partial observation can reach explanation model but never adds hidden identity or engine claims', async () => {
  let request;
  const h = harness({ analyze: async value => { request = value; return '画面是五子棋，执子和规则还未确认。'; } });
  await h.runtime.start({ targetId: 'fixture', authorized: true, game: 'gomoku' });
  await h.runtime.observe();
  assert.equal((await h.runtime.ask('解释画面')).status, 'completed');
  assert.equal(request.context.current_match_state.state.player_color, 'unknown');
  assert.equal(request.context.capabilities.rules_engine, false);
});

test('automatic local observation is opt-in and stop clears owned timers only', async () => {
  const timers = [];
  const cleared = [];
  const h = harness({ setTimer: (callback, ms) => { const token = { callback, ms }; timers.push(token); return token; },
    clearTimer: value => cleared.push(value) });
  await h.runtime.start({ targetId: 'fixture', authorized: true });
  assert.equal(timers.length, 0);
  await h.runtime.start({ targetId: 'fixture', authorized: true, automatic: true });
  assert.equal(timers.length, 1);
  await timers[0].callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls(), 1);
  h.runtime.stop();
  assert.equal(h.runtime.status().session_id, null);
  assert.ok(cleared.length > 0);
});

test('stop during authorization prevents delayed selection from starting a new session', async () => {
  let select;
  const h = harness({ observer: { clear() {}, select: () => new Promise(resolve => { select = resolve; }) } });
  const pending = h.runtime.start({ targetId: 'fixture', authorized: true });
  while (!select) await Promise.resolve();
  h.runtime.stop();
  select({ kind: 'window', id: 'fixture', authorized: true, width: 640, height: 640 });
  await assert.rejects(pending, /session_changed/);
  assert.equal(h.runtime.status().session_id, null);
});

test('board location teaches a bounded window ROI without a model request', async () => {
  const image = boardImage();
  const h = harness({ observer: {
    clear() {}, select: async () => ({ kind: 'window', id: 'fixture', authorized: true, width: 640, height: 640 }),
    capture: async () => ({ image, frame: { target_id: 'fixture', width: 640, height: 640,
      captured_at_ms: 10000, assistant_excluded: true, sha256: 'a'.repeat(64) },
      geometry: { pixel_roi: { x: 0, y: 0, width: 640, height: 640 }, source_size: { width: 640, height: 640 } } }),
  } });
  await h.runtime.start({ targetId: 'fixture', authorized: true, game: 'gomoku' });
  await h.runtime.observe();
  const plan = h.runtime.status().scheduler.plan;
  assert.equal(plan.quality, 'standard');
  assert.ok(plan.roi.x > 0 && plan.roi.y > 0 && plan.roi.width < 1 && plan.roi.height < 1);
  assert.ok(plan.roi.x + plan.roi.width <= 1 && plan.roi.y + plan.roi.height <= 1);
  assert.ok(h.events.some(value => value.event === 'board_region_learned'));
});
