import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,appendFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOverlayService} from '../../dsh-onboarding/overlay-state.mjs';
import {createGameMemory} from '../../dsh-coach-server/lib/game-memory.js';
import {createCloudCoach} from '../auto-coach.mjs';

// The death stage already existed in the coaching plan, but nothing verified that a real
// alive→dead transition reaches the battle page. This runs the production wiring: overlay
// service writes the broadcast log, the cloud coach appends to it, the page picks it up.

const waitFor = async (check, label) => {
  for (let i = 0; i < 150; i += 1) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail('timed out: ' + label);
};

const DEATH_ADVICE = '现在优先补虚空之杖，对面锐雯有黑切；回城先买增幅典籍过渡。';

test('dying publishes what to buy next onto the battle page', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jinbao-death-'));
  let overlay, coach;
  try {
    await mkdir(join(dir, 'logs'));
    const file = join(dir, 'logs/lol-death.jsonl');
    const at = Date.now() - 200;
    const base = {
      game: 'lol', match: 'd1', mode: 'KIWI',
      me: { champion: '安妮', championAlias: 'Annie', level: 11, dead: false, items: [{ name: '兰德里的苦楚' }] },
      allies: [], enemies: [{ champion: '锐雯', items: [{ name: '黑色切割者' }] }],
    };
    await writeFile(file, JSON.stringify({ ...base, kind: 'game_start', t: at, gameTime: 120 }) + '\n');

    overlay = await createOverlayService({
      stateDir: dir, pollMs: 20,
      agentChat: async () => { throw Error('no equipment model'); },
      search: async () => ({ results: [] }),
    });
    const memory = createGameMemory(dir);
    const stages = [];
    coach = createCloudCoach({
      stateDir: dir,
      view: overlay.view,
      getContext: (game, match) => memory.currentFacts(game, match),
      trace: (event) => { if (event.stage) stages.push(event.stage); },
      agent: {
        ask: async (request) => (String(request.question).includes('阵亡') ? DEATH_ADVICE : '本阶段先稳住线权。'),
      },
    });

    await waitFor(() => overlay.view().advice.includes('安妮'), 'state applied');

    // Alive frame first: the coach needs a dead=false baseline before the death counts.
    // Live snapshots carry the clock inside `state.time`; `me` (including dead) is top level.
    await appendFile(file, JSON.stringify({ ...base, kind: 'state', t: at + 100, state: { time: 130 } }) + '\n');
    await waitFor(() => overlay.view().gameTime === '02:10', 'alive frame applied');

    // Let the coach publish its first advice so it has a snapshot for this match.
    await waitFor(async () => { await coach.tick(); return stages.length > 0; }, 'first advice stage');

    // Now the player dies.
    await appendFile(file, JSON.stringify({
      ...base,
      kind: 'state', t: at + 200, state: { time: 140 },
      me: { ...base.me, dead: true, respawn: 12 },
    }) + '\n');
    await waitFor(() => overlay.view().gameTime === '02:20', 'death frame applied');

    await waitFor(async () => {
      await coach.tick();
      return overlay.view().advice.includes('虚空之杖');
    }, 'death advice on the battle page');

    assert.ok(stages.includes('death'), 'the death stage must run, saw ' + JSON.stringify(stages));
  } finally {
    coach?.close();
    await overlay?.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('a busy voice queue does not swallow the death reminder', async () => {
  // The queue gate skips automatic turns while speech is playing, which is how a death
  // reminder used to be lost: by the time the queue cleared the player had respawned.
  const dir = await mkdtemp(join(tmpdir(), 'jinbao-death-busy-'));
  let overlay, coach;
  try {
    await mkdir(join(dir, 'logs'));
    const file = join(dir, 'logs/lol-death2.jsonl');
    const at = Date.now() - 200;
    const base = {
      game: 'lol', match: 'd2', mode: 'KIWI',
      me: { champion: '安妮', championAlias: 'Annie', level: 11, dead: false, items: [{ name: '兰德里的苦楚' }] },
      allies: [], enemies: [{ champion: '锐雯', items: [{ name: '黑色切割者' }] }],
    };
    await writeFile(file, JSON.stringify({ ...base, kind: 'game_start', t: at, gameTime: 120 }) + '\n');
    overlay = await createOverlayService({
      stateDir: dir, pollMs: 20,
      agentChat: async () => { throw Error('no equipment model'); },
      search: async () => ({ results: [] }),
    });
    const memory = createGameMemory(dir);
    const stages = [];
    coach = createCloudCoach({
      stateDir: dir,
      view: overlay.view,
      getContext: (game, match) => memory.currentFacts(game, match),
      canRequest: () => false, // speech is playing for the whole match
      trace: (event) => { if (event.stage) stages.push(event.stage); },
      agent: { ask: async (request) => (String(request.question).includes('阵亡') ? DEATH_ADVICE : '本阶段先稳住线权。') },
    });
    await waitFor(() => overlay.view().advice.includes('安妮'), 'state applied');
    await appendFile(file, JSON.stringify({ ...base, kind: 'state', t: at + 100, state: { time: 130 } }) + '\n');
    await waitFor(() => overlay.view().gameTime === '02:10', 'alive frame applied');
    for (let i = 0; i < 150; i += 1) { await coach.tick(); await new Promise((r) => setTimeout(r, 30)); }
    await appendFile(file, JSON.stringify({
      ...base, kind: 'state', t: at + 200, state: { time: 140 },
      me: { ...base.me, dead: true, respawn: 12 },
    }) + '\n');
    await waitFor(() => overlay.view().gameTime === '02:20', 'death frame applied');
    await waitFor(async () => { await coach.tick(); return overlay.view().advice.includes('虚空之杖'); }, 'death advice despite the busy queue');
    assert.ok(stages.includes('death'), 'the death stage must still run, saw ' + JSON.stringify(stages));
  } finally {
    coach?.close();
    await overlay?.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
