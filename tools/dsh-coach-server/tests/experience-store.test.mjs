import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExperienceStore, claimSimilarity, experienceSection } from '../lib/experience-store.js';
import { buildGameChatMessage } from '../lib/chat-bridge.js';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'jinbao-experience-'));
  const store = createExperienceStore({ dir, maxItems: 4, budgetChars: 160 });
  return { dir, store };
}

test('a lesson seen again strengthens its evidence instead of duplicating the line', async () => {
  const { dir, store } = await fixture();
  try {
    const first = await store.remember({ kind: 'build', claim: '卑尔维斯拿珠光护手后第三件先虚空之杖', scope: ['game:lol', 'champ:卑尔维斯', 'aug:珠光护手'] });
    assert.equal(first.action, 'add');
    const second = await store.remember({ kind: 'build', claim: '卑尔维斯拿珠光护手后第三件先虚空之杖', scope: ['comp:vs锐雯'], evidence: { games: 2, hits: 2 } });
    assert.equal(second.action, 'update');
    const rows = store.snapshot();
    assert.equal(rows.length, 1, 'the same lesson must not be stored twice');
    assert.equal(rows[0].evidence.games, 3);
    assert.ok(rows[0].scope.includes('comp:vs锐雯'), 'scope tags merge across sightings');
    // The markdown mirror is the auditable surface.
    const md = await readFile(join(dir, 'public', 'build.md'), 'utf8');
    assert.match(md, /虚空之杖/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('a refutation demotes a lesson and removes it from the injected pack', async () => {
  const { dir, store } = await fixture();
  try {
    const added = await store.remember({ kind: 'build', claim: '第三件直接做法穿鞋比虚空之杖稳', scope: ['game:lol', 'champ:卑尔维斯'], evidence: { games: 1, hits: 1 } });
    assert.equal(added.action, 'add');
    let pack = await store.retrieve({ tags: ['game:lol', 'champ:卑尔维斯'] });
    assert.equal(pack.lines.length, 1);
    const disputed = await store.remember({ kind: 'build', claim: '第三件直接做法穿鞋比虚空之杖稳', disputes: added.id });
    assert.equal(disputed.action, 'dispute');
    assert.equal(disputed.status, 'stale');
    pack = await store.retrieve({ tags: ['game:lol', 'champ:卑尔维斯'] });
    assert.equal(pack.lines.length, 0, 'a refuted lesson must not be injected any more');
    const md = await readFile(join(dir, 'public', 'build.md'), 'utf8');
    assert.match(md, /stale/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('the player can veto one lesson, and private notes never leave the player', async () => {
  const { dir, store } = await fixture();
  try {
    const preference = await store.remember({ kind: 'preference', player: 'p1', claim: '喜欢激进一点，能打就打', scope: ['game:lol'] });
    assert.equal(preference.action, 'add');
    const other = await store.remember({ kind: 'build', claim: '对面双坦先做重伤', scope: ['game:lol'] });
    assert.equal(other.action, 'add');
    // Another player sees only the shared lesson.
    const pack = await store.retrieve({ tags: ['game:lol'], player: 'p2' });
    assert.equal(pack.lines.some((line) => line.includes('激进')), false);
    const mine = await store.retrieve({ tags: ['game:lol'], player: 'p1' });
    assert.equal(mine.lines.some((line) => line.includes('激进')), true);
    const veto = await store.correct(other.id, '这局对面没有双坦');
    assert.equal(veto.ok, true);
    assert.equal(veto.status, 'stale');
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('a balance patch retires stale advice and the pack stays inside its budget', async () => {
  const { dir, store } = await fixture();
  try {
    await store.remember({ kind: 'strategy', claim: '旧版本才成立的套路', scope: ['game:lol'], patch: '14.20' });
    await store.remember({ kind: 'strategy', claim: '当前版本的团战站位要点', scope: ['game:lol'], patch: '14.21' });
    const same = await store.retrieve({ tags: ['game:lol'], patch: '14.21' });
    assert.equal(same.lines.some((line) => line.includes('旧版本')), false);
    assert.equal(same.lines.some((line) => line.includes('当前版本')), true);
    assert.ok(same.chars <= 160, 'the pack must respect the character budget');
    // Unknown patch keeps everything: we do not silently drop knowledge we cannot date.
    const unknown = await store.retrieve({ tags: ['game:lol'] });
    assert.equal(unknown.lines.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('bigram similarity is what decides "same lesson"', () => {
  assert.ok(claimSimilarity('先补虚空之杖再做法穿鞋', '先补虚空之杖再做法穿鞋') === 1);
  assert.ok(claimSimilarity('先补虚空之杖再做法穿鞋', '先做重伤再补魔抗') < 0.4);
});

test('an empty pack adds nothing to the prompt, a real one is clearly labelled as history', () => {
  assert.equal(experienceSection({ lines: [] }), '');
  assert.equal(experienceSection(null), '');
  const block = experienceSection({ lines: ['[build|0.7|3局] 对面双坦先补重伤'] });
  assert.match(block, /历史经验/);
  assert.match(block, /不覆盖本局事实/);
  assert.match(block, /重伤/);
});

test('the turn message only carries experience when one is supplied', () => {
  const context = { current: { game: 'lol', mode: 'KIWI' } };
  const plain = buildGameChatMessage('这波怎么打？', context);
  assert.equal(plain.includes('历史经验'), false, 'existing callers keep their exact message');
  const withXp = buildGameChatMessage('这波怎么打？', context, 'lol', experienceSection({ lines: ['[strategy|0.6|2局] 首团前先换线'] }));
  assert.match(withXp, /历史经验/);
  assert.match(withXp, /首团前先换线/);
  assert.ok(withXp.includes('【对局与历史数据 JSON】'), 'live facts still come after the history block');
});
