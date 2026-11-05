import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExperienceStore } from '../lib/experience-store.js';
import { createExperienceEditor } from '../lib/agent-experience-edit.mjs';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'jinbao-agent-edit-'));
  const store = createExperienceStore({ dir });
  await store.remember({ kind: 'preference', player: 'local', claim: '喜欢激进开团', scope: ['game:lol'] });
  await store.remember({ kind: 'build', claim: '对面双坦先补重伤', scope: ['game:lol'] });
  return { dir, store, editor: createExperienceEditor({ store }) };
}

test('an agent may not touch shared knowledge', async () => {
  const { dir, editor } = await fixture();
  try {
    const result = await editor.editFile({ kind: 'build', mdText: '- [0.5|1局|candidate] 改掉公共经验', reason: '我觉得不对' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'private-only');
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

test('an edit without a reason is refused', async () => {
  const { dir, editor } = await fixture();
  try {
    const result = await editor.editFile({ kind: 'preference', mdText: '- [0.5|1局|candidate] 喜欢稳一点' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'reason-required');
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

test('one line can be revised without touching the others', async () => {
  const { dir, store, editor } = await fixture();
  try {
    const result = await editor.editLine({ kind: 'preference', from: '喜欢激进开团', to: '现在更想稳一点', reason: '玩家这周输了五把激进局' });
    assert.equal(result.ok, true);
    const rows = store.snapshot().filter((row) => row.kind === 'preference');
    assert.equal(rows.some((row) => row.claim === '喜欢激进开团'), true, 'history is kept');
    assert.equal(rows.find((row) => row.claim === '喜欢激进开团').status, 'retired');
    const fresh = rows.find((row) => row.claim === '现在更想稳一点');
    assert.equal(fresh.evidence.games, 1, 'the new line starts at one game');
    assert.equal(fresh.status, 'candidate');
    const index = await readFile(join(dir, 'index.jsonl'), 'utf8');
    assert.match(index, /edited-by:agent/);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

test('editing a missing line reports it instead of inventing one', async () => {
  const { dir, editor } = await fixture();
  try {
    const result = await editor.editLine({ kind: 'preference', from: '不存在的经验', to: '新的结论', reason: '想修正一条已经不存在的经验' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-found');
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});
