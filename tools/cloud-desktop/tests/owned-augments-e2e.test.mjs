import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,appendFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOverlayService} from '../../dsh-onboarding/overlay-state.mjs';

// The reported bug, end to end: a real match had three augments, but 本局已选 showed two.
// The first one was only ever announced in chat (its panel was missed), and the chat record
// came out confidence:'low' because OCR split the announcement into boxes — so it was
// dropped. This drives the exact event sequence through the real service.

const waitFor = async (check, label) => {
  for (let i = 0; i < 300; i += 1) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail('timed out: ' + label);
};

const ownedText = (view) => {
  const text = String(view().advice ?? '');
  const at = text.indexOf('本局已选');
  return at < 0 ? '' : text.slice(at, at + 160);
};

test('all three augments of a match land in 本局已选 even when one panel was missed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jinbao-owned-e2e-'));
  let service;
  try {
    await mkdir(join(dir, 'logs'));
    const log = join(dir, 'logs/lol-owned.jsonl');
    const at = Date.now() - 200;
    const base = { game: 'lol', match: 'owned1', mode: 'KIWI' };
    await writeFile(log, JSON.stringify({
      ...base, kind: 'load', t: at,
      me: { champion: '虚空女皇', championAlias: 'Belveth', level: 3, items: [] },
      allies: [{ champion: '盖伦' }], enemies: [{ champion: '锐雯' }],
    }) + '\n');

    service = await createOverlayService({
      stateDir: dir, pollMs: 20,
      // Cloud mode has no image route, so an undecided panel must stay undecided.
      agentChat: async () => { throw Object.assign(Error('no model'), { status: 503 }); },
      search: async () => ({ results: [] }),
    });
    await waitFor(() => service.view().game === 'lol', 'state applied');

    // Round 1: the panel was never recognised; the player's augment only shows up in chat.
    await appendFile(log, JSON.stringify({ ...base, kind: 'augment_offer', t: at + 100, roll: 1,
      options: [{ slot: 0, name: '叠角龙' }, { slot: 1, name: '灵巧' }, { slot: 2, name: '家园卫士' }] }) + '\n');
    await appendFile(log, JSON.stringify({ ...base, kind: 'augment_mutate', t: at + 200, roll: 1,
      augment: '急速之追求', champion: '虚空女皇', who: 'self', source: 'log-confirmed', confidence: 'high',
      gameTime: 195 }) + '\n');

    // Round 2 and 3: the watcher read the cards, so they arrive as vision-click.
    await appendFile(log, JSON.stringify({ ...base, kind: 'augment_offer', t: at + 300, roll: 2,
      options: [{ slot: 0, name: '台风' }, { slot: 1, name: '双发快射' }, { slot: 2, name: '大地苏醒' }] }) + '\n');
    await appendFile(log, JSON.stringify({ ...base, kind: 'augment_picked', t: at + 400, roll: 2,
      name: '台风', augment: '台风', who: 'self', source: 'vision-click', confidence: 'high', gameTime: 329 }) + '\n');
    await appendFile(log, JSON.stringify({ ...base, kind: 'augment_offer', t: at + 500, roll: 3,
      options: [{ slot: 0, name: '双发快射' }, { slot: 1, name: '炼狱导管' }, { slot: 2, name: '吃过路兵' }] }) + '\n');
    await appendFile(log, JSON.stringify({ ...base, kind: 'augment_picked', t: at + 600, roll: 3,
      name: '双发快射', augment: '双发快射', who: 'self', source: 'vision-click', confidence: 'high', gameTime: 525 }) + '\n');

    await waitFor(() => {
      const text = ownedText(service.view);
      return text.includes('急速之追求') && text.includes('台风') && text.includes('双发快射');
    }, 'all three augments listed');

    const owned = ownedText(service.view);
    assert.equal(owned.includes('急速之追求'), true, 'the chat-only augment must be owned: ' + owned);
    // A re-read of the same announcement must not add a second copy.
    await appendFile(log, JSON.stringify({ ...base, kind: 'augment_mutate', t: at + 900,
      augment: '双发快射', champion: '虚空女皇', who: 'self', source: 'log-confirmed', confidence: 'high' }) + '\n');
    await new Promise((r) => setTimeout(r, 300));
    const repeated = ownedText(service.view);
    assert.equal(repeated.split('双发快射').length - 1, 1, 'a re-read must not duplicate the augment: ' + repeated);
  } finally {
    await service?.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('a low-confidence chat record never owns an augment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jinbao-owned-low-'));
  let service;
  try {
    await mkdir(join(dir, 'logs'));
    const log = join(dir, 'logs/lol-low.jsonl');
    const at = Date.now() - 200;
    await writeFile(log, JSON.stringify({ game: 'lol', match: 'low1', kind: 'load', t: at,
      me: { champion: '虚空女皇', items: [] }, allies: [], enemies: [] }) + '\n');
    service = await createOverlayService({ stateDir: dir, pollMs: 20,
      agentChat: async () => { throw Object.assign(Error('no model'), { status: 503 }); },
      search: async () => ({ results: [] }) });
    await waitFor(() => service.view().game === 'lol', 'state applied');
    await appendFile(log, JSON.stringify({ game: 'lol', match: 'low1', kind: 'augment_mutate', t: at + 100,
      augment: '台风', champion: '虚空女皇', who: 'self', source: 'log-confirmed', confidence: 'low' }) + '\n');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(ownedText(service.view).includes('台风'), false,
      'without a verb the record may be recorded but must not be owned: ' + ownedText(service.view));
  } finally {
    await service?.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
