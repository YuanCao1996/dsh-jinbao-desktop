import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExperienceStore } from '../lib/experience-store.js';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'jinbao-md-write-'));
  const store = createExperienceStore({ dir });
  await store.remember({ kind: 'build', claim: '对面双坦先补重伤', scope: ['game:lol'] });
  await store.remember({ kind: 'build', claim: '卑尔维斯先做法穿鞋', scope: ['game:lol'] });
  return { dir, store };
}

test('rewriting a line retires the old lesson and keeps the rest untouched', async () => {
  const { dir, store } = await fixture();
  try {
    const mdText = ['- [0.5|2局|candidate] 对面双坦先补法穿', '- [0.5|1局|candidate] 卑尔维斯先做法穿鞋'].join('\n');
    const result = await store.applyMdEdit({ kind: 'build', mdText, by: 'player', reason: '这个版本重伤更好' });
    assert.equal(result.retired, 1);
    assert.equal(result.added, 1);
    const rows = store.snapshot();
    const retired = rows.find((row) => row.claim === '对面双坦先补重伤');
    assert.equal(retired.status, 'retired');
    assert.equal(rows.find((row) => row.claim === '对面双坦先补法穿').status, 'candidate');
    assert.equal(rows.find((row) => row.claim === '卑尔维斯先做法穿鞋').evidence.games, 1, 'the untouched lesson keeps its evidence');
    // 退役的不再被注入
    const pack = await store.retrieve({ tags: ['game:lol'] });
    assert.equal(pack.lines.some((line) => line.includes('先补重伤')), false);
    assert.equal(pack.lines.some((line) => line.includes('先补法穿')), true);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

test('a new line becomes a lesson with one game of evidence and a provenance note', async () => {
  const { dir, store } = await fixture();
  try {
    const mdText = ['- [0.5|2局|candidate] 对面双坦先补重伤', '- [0.5|1局|candidate] 卑尔维斯先做法穿鞋', '- [0.3|9局|public] 五分钟后别单独推线'].join('\n');
    const result = await store.applyMdEdit({ kind: 'build', mdText, by: 'agent', reason: '补充撤退休整经验' });
    assert.equal(result.retired, 0);
    assert.equal(result.added, 1);
    const added = store.snapshot().find((row) => row.claim === '五分钟后别单独推线');
    assert.equal(added.evidence.games, 1, 'a hand-written line does not inherit the number in brackets');
    const index = await readFile(join(dir, 'index.jsonl'), 'utf8');
    assert.match(index, /edited-by:agent/);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});
