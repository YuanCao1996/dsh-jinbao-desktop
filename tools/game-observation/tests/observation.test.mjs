import test from 'node:test';
import assert from 'node:assert/strict';
import { planObservation, validateFrame, validateTarget } from '../contracts.mjs';
import { createObservationPolicy } from '../policy.mjs';

const target = { kind: 'window', id: 'fixture-window', authorized: true, width: 1920, height: 1080 };
const frame = { target_id: target.id, width: 960, height: 540,
  captured_at_ms: 10000, sha256: 'a'.repeat(64), assistant_excluded: true };

test('only explicitly authorized windows are admitted; no desktop fallback', () => {
  assert.deepEqual(validateTarget(target), target);
  for (const bad of [null, { ...target, authorized: false }, { ...target, kind: 'desktop' },
    { ...target, id: '../lol' }, { ...target, width: 0 }, { ...target, height: 0.5 },
    { ...target, width: 100000 }]) assert.throws(() => validateTarget(bad));
});

for (const [width, height] of [[1920, 1080], [2560, 1440], [3440, 1440], [1280, 1024], [1080, 1920]]) {
  test(`ROI stays inside ${width}x${height} and preserves aspect ratio without upscaling`, () => {
    const plan = planObservation({ ...target, width, height }, {
      roi: { x: 0.2, y: 0.1, width: 0.6, height: 0.8 }, quality: 'overview' });
    const box = plan.pixel_roi;
    assert.ok(box.x >= 0 && box.y >= 0);
    assert.ok(box.x + box.width <= width && box.y + box.height <= height);
    assert.ok(Math.max(plan.output_size.width, plan.output_size.height) <= 960);
    assert.ok(plan.output_size.width <= box.width && plan.output_size.height <= box.height);
    assert.ok(Math.abs(plan.output_size.width / plan.output_size.height - box.width / box.height) < 0.01);
    assert.equal(plan.exclude_assistant, true);
  });
}

test('invalid ROI, resolution and capture frequency are rejected instead of silently clamped', () => {
  for (const roi of [{ x: -0.1, y: 0, width: 1, height: 1 }, { x: 0.8, y: 0, width: 0.3, height: 1 },
    { x: 0, y: 0, width: NaN, height: 1 }, { x: 0, y: 0, width: 1, height: 0 },
    { x: 0, y: 0, width: 1, height: 1, monitor: 2 }]) assert.throws(() => planObservation(target, { roi }));
  for (const quality of ['ultra', '__proto__', 'constructor']) {
    assert.throws(() => planObservation(target, { quality }));
  }
  for (const minIntervalMs of [0, 100, 60001, 1000.5]) {
    assert.throws(() => planObservation(target, { minIntervalMs }));
  }
});

test('frame must match the selected window and exclude assistant text; old and future frames are rejected', () => {
  assert.deepEqual(validateFrame(frame, target, 10000), frame);
  for (const patch of [{ target_id: 'other' }, { assistant_excluded: false }, { captured_at_ms: 4999 },
    { captured_at_ms: 10001 }, { width: -1 }, { sha256: 'bad' }]) {
    assert.throws(() => validateFrame({ ...frame, ...patch }, target, 10000));
  }
});

test('disabled, minimized and background targets consume no capture slot', () => {
  let at = 0;
  const policy = createObservationPolicy({ now: () => at });
  assert.equal(policy.capture({ enabled: false }).reason, 'disabled');
  assert.equal(policy.capture({ enabled: true, visible: false, foreground: true }).reason, 'target_not_active');
  assert.equal(policy.capture({ enabled: true, visible: true, foreground: false }).reason, 'target_not_active');
  const active = { enabled: true, visible: true, foreground: true };
  assert.equal(policy.capture(active).allowed, true);
  at = 999;
  assert.equal(policy.capture(active).reason, 'capture_cooldown');
  at = 1000;
  assert.equal(policy.capture(active).allowed, true);
  at = 2000;
  assert.equal(policy.capture({ ...active, intervalMs: 10000 }).reason, 'capture_cooldown');
  at = 11000;
  assert.equal(policy.capture({ ...active, intervalMs: 10000 }).allowed, true);
});

test('cloud calls deduplicate positions and apply monotonic cooldown and match budget to user questions too', () => {
  let at = 0;
  const policy = createObservationPolicy({ now: () => at, maxCloudCalls: 2 });
  const positionHash = 'b'.repeat(64);
  assert.equal(policy.cloud({ positionHash }).allowed, true);
  at = 10000;
  assert.equal(policy.cloud({ positionHash }).reason, 'position_already_analyzed');
  assert.equal(policy.cloud({ positionHash, reason: 'user_question' }).allowed, true);
  at = 20000;
  assert.equal(policy.cloud({ positionHash: 'c'.repeat(64) }).reason, 'cloud_budget_exhausted');
  assert.equal(policy.status().cloud_calls, 2);
});

test('invalid policy and model arguments fail before consuming resources', () => {
  for (const options of [{ minIntervalMs: 0 }, { cloudCooldownMs: 50 }, { maxCloudCalls: 101 }]) {
    assert.throws(() => createObservationPolicy(options));
  }
  const policy = createObservationPolicy();
  assert.throws(() => policy.cloud({ positionHash: 'x' }));
  assert.throws(() => policy.cloud({ positionHash: 'a'.repeat(64), reason: 'loop_forever' }));
  assert.equal(policy.status().cloud_calls, 0);
});
