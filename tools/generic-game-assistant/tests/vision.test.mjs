import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createScreenReader, parseScreenResponse } from '../vision-client.mjs';
import { createGenericRuntime } from '../runtime.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTz8AAAAASUVORK5CYII=', 'base64');
const frame = { target_id: 'fixture', width: 1, height: 1, captured_at_ms: 10000,
  assistant_excluded: true, sha256: createHash('sha256').update(png).digest('hex') };
const facts = { screen_kind: 'other', game_name: null, visual_status: 'partial', texts: ['测试文字'],
  entities: [{ type: 'label', label: '可见对象', box: { x: .1, y: .1, width: .5, height: .5 } }] };
const key = 'jc_'+'a'.repeat(64);
const sharedModel = { baseURL: 'https://api.jinbaoai.top/v1', model: 'game-fast',
  resolveCredential: async () => ({ value: key }) };

test('vision client uses fixed server alias, a matched bounded image and reassembles split UTF8 safely', async () => {
  const logs = [], calls = [];
  const reader = createScreenReader({ sharedModel, log: value => logs.push(value), fetchImpl: async (url, options) => {
    calls.push({ url, options });
    assert.equal(url, 'https://api.jinbaoai.top/v1/chat/completions');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'game-fast'); assert.equal(body.stream, false);
    assert.equal(body.max_tokens, 2048);
    assert.match(options.headers['X-Jinbao-Request-Id'], /^vision-[a-f0-9-]{36}$/);
    assert.equal(body.messages[1].content[1].image_url.url, 'data:image/png;base64,'+png.toString('base64'));
    assert.ok(!options.body.includes(key));
    const raw = Buffer.from(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(facts) } }] }));
    return new Response(new ReadableStream({ start(controller) { for (const byte of raw) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }),
      { headers: { 'X-Request-Id': '12345678-1234-1234-1234-123456789abc, 0123456789abcdef0123456789abcdef' } });
  } });
  const result = await reader({ png, frame, geometry: null });
  assert.deepEqual(result.texts, ['测试文字']); assert.equal(result.entities[0].source, 'cloud');
  assert.equal(calls.length, 1);
  assert.ok(logs.every(value=>value.client_request_id===calls[0].options.headers['X-Jinbao-Request-Id']));
  assert.equal(logs.find(value=>value.event==='visual_http').server_request_id, '12345678-1234-1234-1234-123456789abc');
  assert.equal(logs[0].event, 'visual_request_started');
  assert.ok(!JSON.stringify(logs).includes(key) && !JSON.stringify(logs).includes(png.toString('base64')));
});

test('vision input mismatch, oversized image and arbitrary route are rejected before cloud calls', async () => {
  let calls = 0;
  const reader = createScreenReader({ sharedModel, fetchImpl: async () => { calls++; } });
  await assert.rejects(reader({ png, frame: { ...frame, sha256: 'b'.repeat(64) } }), /image_frame_mismatch/);
  await assert.rejects(reader({ png: Buffer.alloc(32769), frame }), /image_budget_exceeded/);
  assert.throws(() => createScreenReader({ sharedModel: { ...sharedModel, baseURL: 'https://evil.invalid/v1' } }), /invalid_visual_route/);
  assert.equal(calls, 0);
});

test('provider errors and truncated output do not leak raw messages or become confirmed visual facts', async () => {
  const rejected = createScreenReader({ sharedModel, fetchImpl: async () => new Response('private-upstream-detail', { status: 429 }) });
  await assert.rejects(rejected({ png, frame }), error => error.message === 'visual_http_429');
  const truncated = createScreenReader({ sharedModel, fetchImpl: async () => Response.json({ choices: [
    { finish_reason: 'length', message: { content: JSON.stringify(facts) } }] }) });
  await assert.rejects(truncated({ png, frame }), /visual_response_incomplete/);
  assert.throws(() => parseScreenResponse(JSON.stringify({ ...facts, entities: Array(17).fill(facts.entities[0]) })), /invalid_visual_response/);
});

function fixture(readImage) {
  let at = 10000, captures = 0;
  const runtime = createGenericRuntime({ enabled: true, now: () => at, wallNow: () => at,
    readImage, specializedActive: async () => false, observer: {
      select: async () => ({ kind: 'window', id: 'fixture', authorized: true, width: 10, height: 10 }), clear() {},
      capture: async () => { captures++; return { frame: { ...frame, captured_at_ms: at }, png,
        image: { width: 1, height: 1, rgb: new Uint8Array(3) }, geometry: {} }; },
    } });
  return { runtime, advance: ms => { at += ms; }, captures: () => captures };
}

test('cloud image permission is independent from window authorization and observations cause no uploads', async () => {
  let calls = 0;
  const h = fixture(async () => { calls++; return parseScreenResponse(JSON.stringify(facts)); });
  await h.runtime.start({ targetId: 'fixture', authorized: true });
  await h.runtime.observe();
  await assert.rejects(h.runtime.readScreen(), /image_upload_not_authorized/);
  assert.equal(calls, 0); h.runtime.stop();
});

test('generic reader captures on demand, persists validated facts and deduplicates the same image', async () => {
  let calls = 0;
  const h = fixture(async () => { calls++; return parseScreenResponse(JSON.stringify(facts)); });
  await h.runtime.start({ targetId: 'fixture', authorized: true, allowCloudImages: true });
  const first = await h.runtime.readScreen();
  assert.equal(first.status, 'read'); assert.deepEqual(first.state.facts.texts, ['测试文字']);
  const again = await h.runtime.readScreen();
  assert.equal(again.cached, true); assert.equal(calls, 1);
  h.advance(1000); await h.runtime.observe();
  assert.deepEqual(h.runtime.state().facts.texts, ['测试文字']);
  h.runtime.stop();
});

test('slow vision result requires a fresh unchanged local frame before commitment', async () => {
  const h = fixture(async () => { h.advance(6000); return parseScreenResponse(JSON.stringify(facts)); });
  await h.runtime.start({ targetId: 'fixture', authorized: true, allowCloudImages: true });
  let admissions = 0;
  const result = await h.runtime.readScreen({ admitObservation: () => { admissions++; } });
  assert.equal(result.status, 'read'); assert.equal(h.captures(), 2); assert.equal(admissions, 2);
  assert.equal(h.runtime.state().age_ms, 0); h.runtime.stop();
});

test('switching target while vision is pending discards old results even if the provider ignores cancellation', async () => {
  let finish;
  const h = fixture(() => new Promise(resolve => { finish = resolve; }));
  await h.runtime.start({ targetId: 'fixture', authorized: true, allowCloudImages: true });
  const pending = h.runtime.readScreen(); pending.catch(() => {});
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  h.runtime.stop();
  finish(parseScreenResponse(JSON.stringify(facts)));
  await assert.rejects(pending);
  assert.equal(h.runtime.state().facts, null);
});

test('failed image requests consume budget and cooldown but do not permanently blacklist an unchanged picture', async () => {
  let attempts = 0;
  const h = fixture(async () => { if (++attempts === 1) throw new Error('visual_response_incomplete'); return parseScreenResponse(JSON.stringify(facts)); });
  await h.runtime.start({ targetId: 'fixture', authorized: true, allowCloudImages: true });
  await assert.rejects(h.runtime.readScreen(), /visual_response_incomplete/);
  await assert.rejects(h.runtime.readScreen(), /cloud_cooldown/);
  h.advance(10000);
  assert.equal((await h.runtime.readScreen()).status, 'read');
  assert.equal(attempts, 2); assert.equal(h.runtime.status().vision_budget.cloud_calls, 2);
  h.runtime.stop();
});

test('revoking image permission cancels an in-flight upload and cannot commit a delayed result', async () => {
  let finish;
  const h = fixture(() => new Promise(resolve => { finish = resolve; }));
  await h.runtime.start({ targetId: 'fixture', authorized: true, allowCloudImages: true });
  const pending = h.runtime.readScreen(); pending.catch(() => {});
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  h.runtime.setImagePermission(false);
  finish(parseScreenResponse(JSON.stringify(facts)));
  await assert.rejects(pending);
  assert.equal(h.runtime.state().capabilities.image_upload, false);
  assert.equal(h.runtime.state().facts.visual_status, 'unread');
  await assert.rejects(h.runtime.readScreen(), /image_upload_not_authorized/);
  h.runtime.stop();
});

test('unread responses are not cached as successful perception or permanently suppress later explicit reads', async () => {
  let calls = 0;
  const h = fixture(async () => { calls++; return parseScreenResponse(JSON.stringify({ screen_kind: 'unknown',
    game_name: null, visual_status: 'unread', texts: [], entities: [] })); });
  await h.runtime.start({ targetId: 'fixture', authorized: true, allowCloudImages: true });
  assert.equal((await h.runtime.readScreen()).status, 'unread');
  h.advance(10000);
  assert.equal((await h.runtime.readScreen()).status, 'unread');
  assert.equal(calls, 2); h.runtime.stop();
});

test('focused reads pass the question as data and cannot claim the whole screen was read', async () => {
  let calls = 0;
  const reader = createScreenReader({ sharedModel, fetchImpl: async (_, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.equal(JSON.parse(body.messages[1].content[0].text).focus, '顶部文字');
    return Response.json({ choices: [{ finish_reason: 'stop', message: {
      content: JSON.stringify({ ...facts, visual_status: 'read' }) } }] });
  } });
  assert.equal((await reader({ png, frame, focus: '顶部文字' })).visual_status, 'partial');
  await assert.rejects(reader({ png, frame, focus: 'x'.repeat(201) }), /invalid_visual_focus/);
  assert.equal(calls, 1);
});

test('transport timeout and user cancellation have distinct safe diagnostics', async () => {
  const logs = [];
  const reader = createScreenReader({ sharedModel, log: value => logs.push(value),
    fetchImpl: async () => { throw new DOMException('private timeout detail', 'TimeoutError'); } });
  await assert.rejects(reader({ png, frame }), error => error.message === 'visual_timeout');
  assert.equal(logs.at(-1).reason, 'visual_timeout');
  assert.equal(logs.at(-1).client_request_id, logs[0].client_request_id);
  assert.equal(logs.at(-1).server_request_id, undefined);
  assert.ok(Number.isInteger(logs.at(-1).elapsed_ms));
  assert.ok(!JSON.stringify(logs).includes('private timeout detail'));
  const controller = new AbortController();
  const cancelled = createScreenReader({ sharedModel, fetchImpl: async () => {
    controller.abort(); throw new DOMException('private cancellation detail', 'AbortError');
  } });
  await assert.rejects(cancelled({ png, frame, signal: controller.signal }), error => error.message === 'visual_cancelled');
});

test('a different question does not reuse facts cached for another focus', async () => {
  const focuses = [];
  const h = fixture(async ({ focus }) => {
    focuses.push(focus); return parseScreenResponse(JSON.stringify(facts));
  });
  await h.runtime.start({ targetId: 'fixture', authorized: true, allowCloudImages: true });
  await h.runtime.readScreen({ focus: '顶部文字' });
  assert.equal((await h.runtime.readScreen({ focus: '顶部文字' })).cached, true);
  h.advance(10000);
  await h.runtime.readScreen({ focus: '可见对象' });
  assert.deepEqual(focuses, ['顶部文字', '可见对象']);
  h.runtime.stop();
});
