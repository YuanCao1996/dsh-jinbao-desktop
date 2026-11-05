import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExperienceStore } from '../lib/experience-store.js';
import { createExperienceRuntime } from '../lib/experience-runtime.mjs';

async function fixture(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'jinbao-exp-runtime-'));
  const store = createExperienceStore({ dir, maxItems: 4, budgetChars: 200 });
  const runtime = createExperienceRuntime({ store, player: 'p1', patch: '14.21', ...options });
  return { dir, store, runtime };
}

test('one match is distilled exactly once, even though the poll sees it end repeatedly', async () => {
  const { dir, store, runtime } = await fixture();
  try {
    const facts = { match: 'm1', game: 'lol', champion: '卑尔维斯', outcome: 'win', deaths: 3 };
    const first = await runtime.finish(facts);
    assert.equal(first.stored, 1);
    const again = await runtime.finish(facts);
    assert.equal(again.action, 'duplicate');
    assert.equal(again.stored, 0);
    const rows = store.snapshot();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].evidence.games, 1, 'a repeated poll must not add evidence');
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('an unknown result records no champion record but still stores tooling lessons', async () => {
  const { dir, store, runtime } = await fixture();
  try {
    const stored = await runtime.finish({
      match: 'm2', game: 'lol', champion: '安妮', outcome: 'unknown',
      recognition: { blindFrames: 10 },
    });
    assert.equal(stored.stored, 1, 'only the recognition lesson survives an unknown result');
    const rows = store.snapshot();
    assert.equal(rows.some((row) => row.kind === 'stats'), false);
    assert.equal(rows[0].kind, 'recognition');
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('the pack hands the turn a bounded, clearly labelled block and reports what it used', async () => {
  const { dir, store, runtime } = await fixture();
  try {
    await store.remember({ kind: 'build', claim: '对面双坦先补重伤', scope: ['game:lol', 'champ:卑尔维斯'], patch: '14.21' });
    await store.remember({ kind: 'preference', player: 'p1', claim: '喜欢激进开团', scope: ['game:lol'] });
    const pack = await runtime.pack({ tags: ['game:lol', 'champ:卑尔维斯'] });
    assert.match(pack.section, /历史经验/);
    assert.match(pack.section, /重伤/);
    assert.match(pack.section, /激进/);
    assert.equal(pack.ids.length, 2);
    assert.ok(pack.chars >= pack.section.length - 40);
    // A caller with a tiny window can force a tighter cap.
    const tiny = await runtime.pack({ tags: ['game:lol'], maxChars: 60 });
    assert.ok(tiny.section.length <= 60 || tiny.section === '');
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('a patch mismatch keeps old lessons out, and a disabled runtime touches nothing', async () => {
  const { dir, store, runtime } = await fixture();
  try {
    await store.remember({ kind: 'strategy', claim: '旧版本套路', scope: ['game:lol'], patch: '14.20' });
    const pack = await runtime.pack({ tags: ['game:lol'] });
    assert.equal(pack.section, '', 'a lesson from another patch is not injected');
    const off = createExperienceRuntime({ store, enabled: false });
    const stored = await off.finish({ match: 'm9', game: 'lol', champion: '安妮', outcome: 'win' });
    assert.equal(stored.action, 'disabled');
    const offPack = await off.pack({ tags: ['game:lol'] });
    assert.equal(offPack.section, '');
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('lessons survive a restart through the human-readable files', async () => {
  const { dir, store, runtime } = await fixture();
  try {
    await runtime.finish({ match: 'm3', game: 'lol', champion: '卑尔维斯', outcome: 'win' });
    const reopened = createExperienceStore({ dir });
    const rows = await reopened.load();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].claim, '卑尔维斯 战绩记录');
    const md = await readFile(join(dir, 'private', 'p1', 'stats.md'), 'utf8');
    assert.match(md, /卑尔维斯 战绩记录/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
