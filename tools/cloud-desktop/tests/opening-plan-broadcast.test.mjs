import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,appendFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOverlayService} from '../../dsh-onboarding/overlay-state.mjs';

// The opening build plan was only covered at the coach level. This runs the real overlay
// service end to end: a loading game with both teams must reach the battle page as a
// broadcast, be kept on the state, and never be published twice.

const waitFor = async (check, label) => {
  for (let i = 0; i < 150; i += 1) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail('timed out: ' + label);
};

const PLAN = '六件顺序：1 卢登的回声 2 法师之靴 3 影焰 4 灭世者的死亡之帽 5 中娅沙漏 6 虚空之杖；对面锐雯与劫是主要威胁，先做中娅。';

async function start({search = async () => ({ results: [] })} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'jinbao-opening-'));
  await mkdir(join(dir, 'logs'));
  const asked = [];
  const service = await createOverlayService({
    stateDir: dir,
    pollMs: 20,
    search,
    agentChat: async (request) => { asked.push(request); return PLAN; },
  });
  return { dir, service, asked };
}

// The collector announces the loading screen with a `load` event, and that is what puts the
// overlay into phase Loading with both rosters (live snapshots alone do not).
const loadingEvent = (at) => ({
  game: 'lol', match: 'open1', kind: 'load', t: at,
  me: { champion: '安妮', championAlias: 'Annie', level: 1, items: [] },
  allies: ['盖伦', '拉克丝', '赵信', '索拉卡'].map((champion) => ({ champion })),
  enemies: ['锐雯', '劫', '薇恩', '锤石', '阿狸'].map((champion) => ({ champion })),
});

test('a loading game with both teams puts the six-item plan on the battle page once', async () => {
  const { dir, service, asked } = await start();
  try {
    const at = Date.now();
    const log = join(dir, 'logs/lol-open.jsonl');
    await writeFile(log, JSON.stringify(loadingEvent(at)) + '\n');

    await waitFor(() => service.view().advice.includes('卢登'), 'plan reached the battle page');
    const askedOnce = asked.length;
    assert.ok(askedOnce >= 1, 'the agent must be asked for the plan');
    assert.match(asked[0].question, /六件/);

    // Shopping must not erase a plan that covers the whole game.
    await appendFile(log, JSON.stringify({ game: 'lol', match: 'open1', kind: 'state', t: at + 80,
      state: { time: 95, level: 3, items: [{ id: 1052, name: '增幅典籍' }] } }) + '\n');
    await new Promise((r) => setTimeout(r, 300));
    assert.match(service.view().advice, /卢登|六件/, 'the plan must survive the first purchase');

    // A second loading frame with the same teams must not ask again.
    await appendFile(log, JSON.stringify({ ...loadingEvent(at + 100) }) + '\n');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(asked.length, askedOnce, 'the opening plan is per match, not per frame');
    assert.equal(service.view().advice.split('卢登').length - 1 >= 1, true, 'the plan stays visible');
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('a turn that fails never blocks the opening plan from being retried', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jinbao-opening-retry-'));
  await mkdir(join(dir, 'logs'));
  let attempts = 0;
  const service = await createOverlayService({
    stateDir: dir,
    pollMs: 20,
    equipmentOpeningRetryMs: 200,
    search: async () => ({ results: [] }),
    agentChat: async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(Error('busy'), { code: 'agent_preempted' });
      return PLAN;
    },
  });
  try {
    const at = Date.now();
    const log = join(dir, 'logs/lol-open2.jsonl');
    await writeFile(log, JSON.stringify({ game: 'lol', match: 'open2', kind: 'load', t: at,
      me: { champion: '安妮', items: [] },
      allies: [{ champion: '盖伦' }, { champion: '拉克丝' }],
      enemies: [{ champion: '锐雯' }, { champion: '劫' }] }) + '\n');
    await waitFor(() => service.view().advice.includes('卢登'), 'plan retried after a failed turn');
    assert.ok(attempts >= 2, 'a failed opening turn must be retried, saw ' + attempts);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
