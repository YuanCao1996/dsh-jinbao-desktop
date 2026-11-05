import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExperienceStore } from '../lib/experience-store.js';
import { uploadCandidates, mergeRemote } from '../lib/public-sync.mjs';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'jinbao-pub-sync-'));
  const store = createExperienceStore({ dir });
  return { dir, store };
}
const remote = () => [{
  fingerprint: 'r1', kind: 'recognition', claim: '高光遮挡时先双帧比对再判定',
  scope: ['game:lol'], patch: null, evidence: { games: 4, hits: 4, counter: 0 },
}];

test('only shareable lessons leave the machine', async () => {
  const { dir, store } = await fixture();
  try {
    await store.remember({ kind: 'build', claim: '对面双坦先补重伤', scope: ['game:lol'], patch: '14.21' });
    await store.remember({ kind: 'preference', player: 'local', claim: '喜欢激进开团', scope: ['game:lol'] });
    await store.remember({ kind: 'stats', player: 'local', claim: '卑尔维斯 战绩记录', scope: ['game:lol'] });
    const up = await uploadCandidates(store);
    assert.equal(up.lessons.length, 1, 'only the build lesson may be uploaded');
    assert.equal(up.lessons[0].claim, '对面双坦先补重伤');
    assert.equal(up.rejected.length, 2);
    assert.equal(up.rejected.length, 2);
    assert.equal(up.rejected.every((row) => ['private-record','private-kind','player-tagged'].includes(row.reason)), true);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

test('pulling the same lesson twice never inflates its evidence', async () => {
  const { dir, store } = await fixture();
  try {
    const first = await mergeRemote(store, dir, remote());
    assert.equal(first.merged, 1);
    const again = await mergeRemote(store, dir, remote());
    assert.equal(again.merged, 0, 'the second pull is skipped');
    assert.equal(again.skipped, 1);
    const row = store.snapshot().find((entry) => entry.kind === 'recognition');
    assert.equal(row.evidence.games, 4, 'evidence matches the server total, not double of it');
    assert.equal(row.private, false);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

test('a lesson already known locally merges instead of duplicating', async () => {
  const { dir, store } = await fixture();
  try {
    await store.remember({ kind: 'recognition', claim: '高光遮挡时先双帧比对再判定', scope: ['game:lol'] });
    await mergeRemote(store, dir, remote());
    const rows = store.snapshot().filter((entry) => entry.kind === 'recognition');
    assert.equal(rows.length, 1, 'same knowledge stays one row');
    assert.ok(rows[0].evidence.games >= 5, 'local sighting plus remote evidence');
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

test('a malformed remote lesson is skipped rather than crashing the sync', async () => {
  const { dir, store } = await fixture();
  try {
    const result = await mergeRemote(store, dir, [{ claim: '' }, { kind: 'build' }, null]);
    assert.equal(result.merged, 0);
    assert.equal(result.skipped, 3);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});
