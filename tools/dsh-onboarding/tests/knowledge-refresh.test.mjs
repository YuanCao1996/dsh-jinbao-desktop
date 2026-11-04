import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,appendFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOverlayService} from '../overlay-state.mjs';

// A real match showed the augments page stuck on "正在查询英雄适配排名…" for the whole game
// while the retrieval endpoint answered fine from the same token. The refresh used to run
// only when a context key changed, and nothing recorded whether it had even started, so the
// failure was invisible. These pin the two things that make it observable and self-healing.

const waitFor = async (check, label) => {
  for (let i = 0; i < 500; i += 1) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail('timed out: ' + label);
};

const AUGMENTS = [
  { name: '屹立不倒', champion: '虚空女皇 卑尔维斯', winRate: 58.65, tier: 'T1', rank: 1, _type: 'augments' },
  { name: '双刀流', champion: '虚空女皇 卑尔维斯', winRate: 58.14, tier: 'T1', rank: 2, _type: 'augments' },
];

async function serviceWith(search) {
  const dir = await mkdtemp(join(tmpdir(), 'jinbao-knowledge-'));
  await mkdir(join(dir, 'logs'));
  const service = await createOverlayService({
    stateDir: dir,
    pollMs: 20,
    search,
    agentChat: async () => { throw Object.assign(Error('no model'), { status: 503 }); },
  });
  const at = Date.now();
  await appendFile(join(dir, 'logs/lol-kn.jsonl'), JSON.stringify({
    game: 'lol', match: 'kn1', kind: 'state', t: at,
    me: { champion: '虚空女皇', championAlias: 'Belveth', level: 11, items: [] },
    allies: ['盖伦', '拉克丝', '赵信', '索拉卡'].map((champion) => ({ champion })),
    enemies: ['锐雯', '劫', '薇恩', '锤石', '阿狸'].map((champion) => ({ champion })),
  }) + '\n');
  return { dir, service };
}

test('a champion lookup fills the Top10 page and records the attempt', async () => {
  const { dir, service } = await serviceWith(async (query) => ({
    results: query.filter?._type === 'augments' ? AUGMENTS.map((data) => ({ data }))
      : query.dataset === 'aram-ranking' ? [{ data: { name: '卑尔维斯', title: '虚空女皇', winRate: 56.31, tier: 3 } }]
      : [],
  }));
  try {
    await waitFor(() => /屹立不倒/.test(service.view().augments), 'Top10 rendered');
    const status = JSON.parse(await readFile(join(dir, 'knowledge-status.json'), 'utf8'));
    assert.equal(status.phase === 'started' && status.rows === 0, false, 'the finished record must replace the started one');
    assert.ok(status.rows >= 2, 'the finished record must report the rows it loaded: ' + JSON.stringify(status));
    assert.equal(status.champion, '虚空女皇');
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('an empty lookup keeps retrying instead of waiting for a context change', async () => {
  let calls = 0;
  const { dir, service } = await serviceWith(async (query) => {
    if (query.filter?._type === 'augments') {
      calls += 1;
      // The first lookup answers empty, as a cache miss would; the page must not stay blank.
      return { results: calls >= 2 ? AUGMENTS.map((data) => ({ data })) : [] };
    }
    return { results: [] };
  });
  try {
    await waitFor(() => /屹立不倒/.test(service.view().augments), 'Top10 rendered after a retry');
    assert.ok(calls >= 2, 'the lookup must be retried, saw ' + calls);
    const status = JSON.parse(await readFile(join(dir, 'knowledge-status.json'), 'utf8'));
    assert.ok(status.rows >= 1, 'the finished record must show the loaded rows');
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failing lookup leaves a record that says why the page is empty', async () => {
  const { dir, service } = await serviceWith(async () => { throw Object.assign(Error('denied'), { status: 401 }); });
  try {
    await waitFor(async () => {
      try {
        const status = JSON.parse(await readFile(join(dir, 'knowledge-status.json'), 'utf8'));
        return status.phase !== 'started' && status.failed === true;
      } catch { return false; }
    }, 'failure recorded');
    const status = JSON.parse(await readFile(join(dir, 'knowledge-status.json'), 'utf8'));
    // 基础查询三条 + 每个已知英雄一条，全部失败时都应记为 401。
    assert.ok(status.errors.length >= 3, 'every failed lookup must be counted: ' + JSON.stringify(status.errors));
    assert.equal(status.errors.every((code) => code === 401), true, 'got ' + JSON.stringify(status.errors));
    assert.match(status.message, /授权|登录/);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
