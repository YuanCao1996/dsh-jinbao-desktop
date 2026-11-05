import test from 'node:test';
import assert from 'node:assert/strict';
import { stripIdentity, toPublicLesson, toPublicLessons, mergePublicLessons, claimFingerprint } from '../lib/public-lessons.mjs';

test('anything that belongs to one player never becomes a public lesson', () => {
  assert.equal(toPublicLesson({ kind: 'preference', claim: '喜欢激进开团' }).reason, 'private-kind');
  assert.equal(toPublicLesson({ kind: 'stats', claim: '安妮战绩', player: 'p1' }).reason, 'private-kind');
  assert.equal(toPublicLesson({ kind: 'build', claim: '对面双坦先补重伤', player: 'p1' }).reason, 'player-tagged');
  assert.equal(toPublicLesson({ kind: 'build', claim: '对面双坦先补重伤', private: true }).reason, 'private-record');
  assert.equal(toPublicLesson({ kind: 'mystery', claim: 'x' }).reason, 'unknown-kind');
  assert.equal(toPublicLesson(null).ok, false);
});

test('identity is stripped from free text and from scope tags', () => {
  assert.equal(stripIdentity('刚才 @小明 说的那套'), '刚才 说的那套');
  assert.equal(stripIdentity('队友 abc#1234 的出装'), '队友 的出装');
  assert.equal(stripIdentity('电话 13800138000 记一下'), '电话 记一下');
  assert.equal(stripIdentity('他说“先做重伤”再打'), '他说再打');
  const converted = toPublicLesson({ kind: 'strategy', claim: '@小明 说首团前换线', scope: ['game:lol', 'player:123', 'champ:安妮'] });
  assert.equal(converted.ok, true);
  assert.equal(converted.lesson.claim.includes('小明'), false);
  assert.deepEqual(converted.lesson.scope, ['game:lol', 'champ:安妮'], 'player tags are dropped');
  assert.equal(converted.lesson.fingerprint, claimFingerprint(converted.lesson.claim));
});

test('the upload payload states reasons for everything it refuses', () => {
  const { lessons, rejected } = toPublicLessons([
    { id: 'a', kind: 'recognition', claim: '卡面多帧读不出名字时先双帧比对', scope: ['game:lol'], evidence: { games: 2, hits: 2, counter: 0 } },
    { id: 'b', kind: 'pitfall', claim: '我老是单走', scope: ['game:lol'] },
    { id: 'c', kind: 'build', claim: '对面双坦先补重伤', player: 'p1' },
  ]);
  assert.equal(lessons.length, 1);
  assert.equal(lessons[0].evidence.games, 2);
  assert.deepEqual(rejected, [{ id: 'b', reason: 'private-kind' }, { id: 'c', reason: 'player-tagged' }]);
});

test('merging accumulates evidence instead of duplicating the same lesson', () => {
  const local = [{ fingerprint: 'f1', kind: 'build', claim: '对面双坦先补重伤', scope: ['game:lol'], patch: '14.21', evidence: { games: 3, hits: 2, counter: 0 } }];
  const remote = [
    { fingerprint: 'f1', kind: 'build', claim: '对面双坦先补重伤', scope: ['champ:安妮'], patch: '14.21', evidence: { games: 5, hits: 4, counter: 1 } },
    { fingerprint: 'f2', kind: 'recognition', claim: '高光遮挡时双帧比对', scope: ['game:lol'], patch: null, evidence: { games: 1, hits: 1, counter: 0 } },
  ];
  const merged = mergePublicLessons(local, remote);
  assert.equal(merged.lessons.length, 2, 'same knowledge must not be stored twice');
  assert.equal(merged.updated, 1);
  assert.equal(merged.added, 1);
  const same = merged.lessons.find((row) => row.fingerprint === 'f1');
  assert.equal(same.evidence.games, 8);
  assert.equal(same.evidence.hits, 6);
  assert.equal(same.evidence.counter, 1, 'a refutation is never averaged away');
  assert.deepEqual(same.scope, ['game:lol', 'champ:安妮']);
});

test('a different patch keeps both versions of the same advice', () => {
  const local = [{ fingerprint: 'f1', kind: 'strategy', claim: '首团前先换线', scope: ['game:lol'], patch: '14.20', evidence: { games: 2, hits: 2, counter: 0 } }];
  const remote = [{ fingerprint: 'f1', kind: 'strategy', claim: '首团前先换线', scope: ['game:lol'], patch: '14.21', evidence: { games: 1, hits: 1, counter: 0 } }];
  const merged = mergePublicLessons(local, remote);
  assert.equal(merged.lessons.length, 2);
  assert.equal(merged.added, 1);
});
