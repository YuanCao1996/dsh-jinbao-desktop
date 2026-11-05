import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicLibrary } from '../lib/public-library.mjs';

const lesson = (over = {}) => ({
  fingerprint: 'f1', kind: 'build', claim: '对面双坦先补重伤', scope: ['game:lol'], patch: '14.21',
  evidence: { games: 2, hits: 2, counter: 0 }, ...over,
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'jinbao-pub-lib-'));
  const library = createPublicLibrary({ dir, now: () => Date.parse('2026-11-05T00:00:00Z') });
  return { dir, library };
}

test('the same knowledge accumulates evidence instead of creating rows', async () => {
  const { dir, library } = await fixture();
  try {
    const first = await library.upsert([lesson()]);
    assert.equal(first.added, 1);
    const second = await library.upsert([lesson({ scope: ['champ:安妮'], evidence: { games: 3, hits: 1, counter: 1 } })]);
    assert.equal(second.updated, 1);
    assert.equal(second.added, 0);
    const rows = await library.query({ game: 'lol', patch: '14.21' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].evidence.games, 5);
    assert.equal(rows[0].evidence.hits, 3);
    assert.equal(rows[0].evidence.counter, 1, 'a refutation is never averaged away');
    assert.deepEqual(rows[0].scope, ['game:lol', 'champ:安妮']);
    const md = await readFile(join(dir, 'public', 'build.md'), 'utf8');
    assert.match(md, /重伤/);
    assert.equal(md.includes('f1'), false, 'the human file carries knowledge, not internals');
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

test('private or player-tagged uploads are rejected with a reason', async () => {
  const { dir, library } = await fixture();
  try {
    const result = await library.upsert([
      lesson({ fingerprint: 'ok' }),
      lesson({ fingerprint: 'p', kind: 'pitfall' }),
      lesson({ fingerprint: 'q', player: 'p1' }),
    ]);
    assert.equal(result.added, 1);
    assert.equal(result.rejected.length, 2);
    assert.deepEqual(result.rejected.map((row) => row.reason).sort(), ['player-tagged', 'private-kind']);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

test('a lesson from another patch is not served, undated knowledge still is', async () => {
  const { dir, library } = await fixture();
  try {
    await library.upsert([
      lesson({ fingerprint: 'old', patch: '14.20', claim: '旧版本的对面双坦对策' }),
      lesson({ fingerprint: 'new', patch: '14.21', claim: '当前版本对面双坦先补重伤' }),
      lesson({ fingerprint: 'undated', patch: null, claim: '高光遮挡时双帧比对', kind: 'recognition' }),
    ]);
    const current = await library.query({ game: 'lol', patch: '14.21' });
    const claims = current.map((row) => row.claim);
    assert.equal(claims.some((claim) => claim.includes('对面双坦')), true);
    assert.equal(claims.some((claim) => claim.includes('高光遮挡')), true);
    assert.equal(claims.filter((claim) => claim.includes('对面双坦')).length, 1, 'only the current patch version is served');
    // Other games never see lol lessons.
    const wzry = await library.query({ game: 'wzry', patch: '14.21' });
    assert.equal(wzry.length, 0);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

test('ranked results prefer well-confirmed lessons and honour the limit', async () => {
  const { dir, library } = await fixture();
  try {
    await library.upsert([
      lesson({ fingerprint: 'weak', claim: '这条只被验证过一次的经验', evidence: { games: 1, hits: 1, counter: 0 } }),
      lesson({ fingerprint: 'strong', claim: '这条被验证过很多次的经验', evidence: { games: 20, hits: 19, counter: 0 } }),
    ]);
    const rows = await library.query({ game: 'lol', patch: '14.21', limit: 1 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].claim, '这条被验证过很多次的经验');
    assert.ok(rows[0].confidence > 0.8);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

test('pruning drops never-confirmed knowledge that nobody added to for half a year', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jinbao-pub-lib-'));
  try {
    const then = createPublicLibrary({ dir, now: () => Date.parse('2026-01-01T00:00:00Z') });
    await then.upsert([lesson({ fingerprint: 'stale', evidence: { games: 1, hits: 0, counter: 0 } })]);
    const later = createPublicLibrary({ dir, now: () => Date.parse('2026-11-05T00:00:00Z') });
    const result = await later.prune({ staleDays: 180 });
    assert.equal(result.removed, 1);
    assert.equal((await later.stats()).total, 0);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

test('one account cannot promote its own lesson, three independent accounts can', async () => {
  const { dir, library } = await fixture();
  try {
    await library.upsert([lesson({ fingerprint: 'x', claim: '对面双坦先补重伤' })], { account: 'a' });
    await library.upsert([lesson({ fingerprint: 'x', claim: '对面双坦先补重伤' })], { account: 'a' });
    let rows = await library.query({ game: 'lol', patch: '14.21', includePending: false });
    assert.equal(rows.length, 0, 'a single account stays in the pending pool');
    await library.upsert([lesson({ fingerprint: 'x', claim: '对面双坦先补重伤' })], { account: 'b' });
    rows = await library.query({ game: 'lol', patch: '14.21', includePending: false });
    assert.equal(rows.length, 0, 'two accounts are still pending');
    await library.upsert([lesson({ fingerprint: 'x', claim: '对面双坦先补重伤' })], { account: 'c' });
    rows = await library.query({ game: 'lol', patch: '14.21', includePending: false });
    assert.equal(rows.length, 1, 'three independent accounts promote it');
    const pending = await library.query({ game: 'lol', patch: '14.21', includePending: true });
    assert.equal(pending.length, 1);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});
