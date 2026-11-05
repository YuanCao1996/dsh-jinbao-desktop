import test from 'node:test';
import assert from 'node:assert/strict';
import { contextTags, buildInjection } from '../lib/public-injector.mjs';

const lesson = (over = {}) => ({
  fingerprint: 'f1', kind: 'build', claim: '对面双坦先补重伤', scope: ['game:lol', 'champ:安妮'],
  patch: null, evidence: { games: 6, hits: 6, counter: 0 }, ...over,
});

test('client context becomes a small whitelist of tags', () => {
  const tags = contextTags({ game: 'lol', champion: '安妮', augments: ['珠光护手', '', 'a', 'b'], comps: ['vs锐雯'], phase: 'InProgress', dead: true, evil: '<script>' });
  assert.deepEqual(tags, ['game:lol', 'champ:安妮', 'aug:珠光护手', 'aug:a', 'comp:vs锐雯', 'phase:inprogress', 'event:death']);
  assert.equal(tags.some((tag) => tag.includes('script')), false, 'unknown keys are ignored');
  assert.deepEqual(contextTags({}), []);
});

test('only matching lessons are injected, best first, and never their internals', () => {
  const lessons = [
    lesson({ fingerprint: 'hit', scope: ['game:lol', 'champ:安妮'], evidence: { games: 6, hits: 6, counter: 0 } }),
    lesson({ fingerprint: 'other', claim: '卑尔维斯拿珠光护手先出法穿', scope: ['game:lol', 'champ:卑尔维斯'], evidence: { games: 9, hits: 9, counter: 0 } }),
  ];
  const result = buildInjection({ lessons, context: { game: 'lol', champion: '安妮' } });
  assert.match(result.section, /社区经验/);
  assert.match(result.section, /不覆盖本局事实/);
  assert.match(result.section, /重伤/);
  assert.equal(result.section.includes('卑尔维斯'), false, 'an unrelated champion lesson is not injected');
  assert.deepEqual(result.used, ['hit']);
  assert.equal(result.section.includes('fingerprint'), false);
  assert.equal(result.section.includes('scope'), false);
});

test('the injected block respects its character budget', () => {
  const lessons = Array.from({ length: 12 }, (_, index) => lesson({
    fingerprint: 'f' + index, claim: '这是一条足够长的经验结论用来把预算撑满' + index,
    evidence: { games: 20, hits: 19, counter: 0 },
  }));
  const result = buildInjection({ lessons, context: { game: 'lol', champion: '安妮' }, budgetChars: 160 });
  assert.ok(result.section.length <= 160, 'budget was ' + result.section.length);
  assert.ok(result.used.length >= 1);
  assert.ok(result.dropped >= 1);
});

test('lessons from another patch are skipped while undated ones stay', () => {
  const lessons = [
    lesson({ fingerprint: 'old', patch: '14.20' }),
    lesson({ fingerprint: 'undated', patch: null, claim: '高光遮挡时先取前后两帧比对再判定', kind: 'recognition' }),
  ];
  const result = buildInjection({ lessons, context: { game: 'lol', champion: '安妮' }, patch: '14.21' });
  assert.deepEqual(result.used, ['undated']);
});
