import test from 'node:test';
import assert from 'node:assert/strict';
import { boundJsonStringify, boundPrompt, MAX_CONTEXT_BYTES, MAX_PROMPT_BYTES } from '../lib/context-budget.js';

const bytes = value => Buffer.byteLength(value, 'utf8');

test('a context already inside the budget is passed through untouched', () => {
  const context = { current: { match: 'm', champion: '安妮' }, events: [{ text: '装备更新' }] };
  const result = boundJsonStringify(context);
  assert.equal(result.trimmed, false);
  assert.equal(result.text, JSON.stringify(context));
  assert.equal(result.bytes, result.originalBytes);
});

test('a 377 KB turn is reduced below the budget (the measured production failure)', () => {
  // Mirrors the observed shape: many events plus accumulated cross-match history.
  const events = Array.from({ length: 400 }, (_, i) => ({
    time: '12:34', topic: 'equipment', text: `装备更新：英雄${i} 新增 装备名称较长的一条记录`.repeat(12),
  }));
  const previousMatches = Array.from({ length: 30 }, (_, i) => ({
    match: 'lol-live-' + i, summary: '上一局摘要'.repeat(400),
  }));
  const context = { current: { match: 'm', champion: '镕铁少女' }, events, previousMatches };

  const originalBytes = bytes(JSON.stringify(context));
  assert.ok(originalBytes > 300_000, `fixture should reproduce the oversize case, got ${originalBytes}`);

  const result = boundJsonStringify(context);
  assert.equal(result.trimmed, true);
  assert.ok(result.bytes <= MAX_CONTEXT_BYTES, `bounded to ${result.bytes} bytes`);
  assert.ok(result.bytes < MAX_CONTEXT_BYTES * 0.95);
});

test('cross-match history is dropped before recent events are reduced', () => {
  const events = Array.from({ length: 60 }, (_, i) => ({ text: `事件${i}`, pad: 'x'.repeat(400) }));
  const previousMatches = Array.from({ length: 20 }, () => ({ summary: 'y'.repeat(2000) }));
  const result = boundJsonStringify({ events, previousMatches });
  const parsed = JSON.parse(result.text);
  assert.deepEqual(parsed.previousMatches, []);
  assert.ok(parsed.events.length <= 60);
});

test('the newest events survive the reduction', () => {
  const events = Array.from({ length: 300 }, (_, i) => ({ text: `事件${i}`, pad: 'z'.repeat(600) }));
  const result = boundJsonStringify({ events });
  const parsed = JSON.parse(result.text);
  assert.ok(parsed.events.length > 0);
  assert.equal(parsed.events.at(-1).text, '事件299');
});

test('a pathological single string cannot blow the budget on its own', () => {
  const result = boundJsonStringify({ raw: 'x'.repeat(400_000), match: 'm' });
  assert.equal(result.trimmed, true);
  assert.ok(result.bytes <= MAX_CONTEXT_BYTES);
  assert.match(result.text, /\[已截断\]/);
});

test('an oversized adapter prompt is clipped and marked, a normal one is not', () => {
  const small = boundPrompt('简短问题');
  assert.equal(small.trimmed, false);

  const large = boundPrompt('提示'.repeat(60_000));
  assert.equal(large.trimmed, true);
  assert.ok(large.bytes <= MAX_PROMPT_BYTES);
  assert.match(large.text, /\[已截断\]$/);
});

test('bounding is stable when called twice on its own output', () => {
  const context = { events: Array.from({ length: 200 }, (_, i) => ({ text: `事件${i}`, pad: 'q'.repeat(500) })) };
  const once = boundJsonStringify(context);
  const twice = boundJsonStringify(JSON.parse(once.text));
  assert.ok(twice.bytes <= MAX_CONTEXT_BYTES);
});

test('the context budget stays clear of the compaction threshold', () => {
  // profile declares contextWindow 32768 with compaction thresholdRatio 0.7 -> 22,933
  // tokens; that budget must also hold the system prompt, 18 tool schemas and the reply.
  const thresholdTokens = 32768 * 0.7;
  const approximateTokens = MAX_CONTEXT_BYTES / 2.2; // conservative bytes-per-token for CJK
  assert.ok(approximateTokens < thresholdTokens * 0.6,
    `budget ${MAX_CONTEXT_BYTES} B (~${Math.round(approximateTokens)} tok) must leave headroom under ${thresholdTokens}`);
  // Quota is metered in bytes on the gateway, so the ceiling also bounds spend.
  assert.ok(MAX_CONTEXT_BYTES <= 24_000, 'quota is byte-metered; keep the injected context small');
});
