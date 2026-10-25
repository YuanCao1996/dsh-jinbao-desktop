import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindowObserver, decodeCapturedFrame } from '../windows.mjs';

const target = { id: 'win-fixture', width: 640, height: 640, foreground: true };

test('default-off Windows observer starts no process or enumeration', async () => {
  let calls = 0;
  const observer = createWindowObserver({ worker: async () => { calls++; } });
  assert.deepEqual(await observer.list(), []);
  await assert.rejects(observer.select({ id: target.id, authorized: true }), /observation_disabled/);
  await assert.rejects(observer.capture(), /observation_disabled/);
  assert.equal(calls, 0);
});

test('selected window must exist exactly, be authorized and cannot fall back to desktop', async () => {
  const observer = createWindowObserver({ enabled: true, worker: async () => ({ windows: [target] }) });
  await assert.rejects(observer.select({ id: target.id }), /authorized_window_required/);
  await assert.rejects(observer.select({ id: 'substring', authorized: true }), /target_not_available/);
  await assert.rejects(observer.capture(), /no_authorized_window/);
  assert.equal((await observer.select({ id: target.id, authorized: true })).id, target.id);
});

test('clearing/reselecting prevents a late capture from entering the new target', async () => {
  let finish;
  const observer = createWindowObserver({ enabled: true, worker: async request => request.action === 'list'
    ? { windows: [target] } : new Promise(resolve => { finish = resolve; }) });
  await observer.select({ id: target.id, authorized: true });
  const capture = observer.capture();
  await assert.rejects(observer.capture(), /capture_busy/);
  observer.clear();
  finish({});
  await assert.rejects(capture, /target_changed/);
});

test('forged frame source, dimensions and malformed image are rejected', () => {
  const plan = { output_size: { width: 640, height: 640 } };
  assert.throws(() => decodeCapturedFrame({ frame: { source: 'desktop', width: 640, height: 640 } }, target, plan), /invalid_capture_payload/);
  assert.throws(() => decodeCapturedFrame({ frame: { source: 'windows_printwindow',
    exclusion_method: 'target_client_render_only', width: 640, height: 640,
    png_base64: 'abcd', rgb_base64: 'abcd' } }, target, plan), /invalid_capture_image/);
});
