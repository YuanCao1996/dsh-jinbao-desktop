import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { distillMatch, MAX_LESSONS } from '../lib/experience-distill.js';
import { createExperienceStore } from '../lib/experience-store.js';

test('a finished game yields at most three candidates and never invents public lessons from a win', () => {
  const candidates = distillMatch({
    game: 'lol', champion: '卑尔维斯', patch: '14.21', player: 'p1', outcome: 'win', deaths: 9,
  });
  assert.ok(candidates.length <= MAX_LESSONS);
  assert.equal(candidates[0].kind, 'stats');
  assert.equal(candidates[0].private, true);
  assert.equal(candidates[0].evidence.hits, 1, 'a win counts as a hit');
  // No build/strategy candidate: we cannot attribute an item purchase to the win.
  assert.equal(candidates.some((row) => row.kind === 'build' || row.kind === 'strategy'), false);
});

test('a loss records a miss, and the champion record merges across matches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jinbao-distill-'));
  try {
    const store = createExperienceStore({ dir });
    for (const outcome of ['win', 'win', 'loss']) {
      for (const candidate of distillMatch({ game: 'lol', champion: '卑尔维斯', player: 'p1', outcome })) {
        await store.remember(candidate);
      }
    }
    const rows = store.snapshot();
    assert.equal(rows.length, 1, 'three matches must not create three champion records');
    assert.equal(rows[0].evidence.games, 3);
    assert.equal(rows[0].evidence.hits, 2, 'two wins are two hits');
    assert.equal(rows[0].private, true);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('ignored death reminders become a private pitfall; blind recognition becomes a shared lesson', () => {
  const candidates = distillMatch({
    game: 'lol', champion: '安妮', player: 'p1', outcome: 'loss',
    deathReminders: [{ ignoredAfterReminder: true }, { ignoredAfterReminder: true }, { ignoredAfterReminder: false }],
    recognition: { blindFrames: 12, rounds: 1 },
  });
  const pitfall = candidates.find((row) => row.kind === 'pitfall');
  const recognition = candidates.find((row) => row.kind === 'recognition');
  assert.ok(pitfall, 'two ignored reminders are a pattern');
  assert.equal(pitfall.private, true);
  assert.equal(recognition.private, undefined, 'recognition knowledge is shared');
  assert.equal(recognition.evidence.hits, 1);
  assert.equal(candidates.length, MAX_LESSONS);
});

test('one ignored reminder is noise, and unknown outcomes do not inflate confidence', () => {
  const candidates = distillMatch({ game: 'lol', champion: '安妮', player: 'p1', outcome: 'unknown', deathReminders: [{ ignoredAfterReminder: true }] });
  assert.equal(candidates.some((row) => row.kind === 'pitfall'), false);
  const stats = candidates.find((row) => row.kind === 'stats');
  assert.equal(stats.evidence.hits, 0);
});

test('without a player there is no private lesson, and no champion means no champion record', () => {
  const anonymous = distillMatch({ game: 'lol', champion: '安妮', outcome: 'win' });
  assert.equal(anonymous.length, 0, 'private facts need a player identity');
  const noChampion = distillMatch({ game: 'lol', player: 'p1', outcome: 'win', deaths: 2 });
  assert.equal(noChampion.some((row) => row.kind === 'stats'), false);
});
