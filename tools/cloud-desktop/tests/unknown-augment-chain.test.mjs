import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,appendFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAugmentObserver,augmentNames} from '../../lol-companion/augment-observer.mjs';
import {createOverlayService} from '../../dsh-onboarding/overlay-state.mjs';

// A real match lost a card because the shipped catalogue had never learned its name, and the
// pick then landed on the neighbouring card. These tests drive the whole chain with the real
// catalogue and a name that is deliberately not in it: panel -> offer -> page -> owned.

const waitFor = async (check, label) => {
  for (let i = 0; i < 150; i += 1) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail('timed out: ' + label);
};

test('a card missing from the catalogue still reaches the panel and the owned list', async () => {
  const names = await augmentNames();
  const emitted = [];
  const observer = createAugmentObserver(names, (event) => emitted.push(event));
  const frame = () => ({
    available: true, foreground: true, width: 1920, height: 1080,
    cardLayout: 'stacked-title-regions', capturedAt: Date.now(),
    // Slot 1 and 2 are real catalogue entries; slot 0 is a name the catalogue never learned.
    titleLines: [
      { text: '神 秘 新 强 化', slot: 0, x: 600, y: 430 },
      { text: '灵 魂 虹 吸', slot: 1, x: 900, y: 430 },
      { text: '易 损', slot: 2, x: 1200, y: 430 },
    ],
    lines: [],
  });
  for (let i = 0; i < 3; i += 1) observer.observe(frame());
  const offer = emitted.filter((event) => event.kind === 'augment_offer').at(-1);
  assert.ok(offer, 'the panel must be recognised');
  assert.deepEqual(offer.options.map((option) => option.name), ['神秘新强化', '灵魂虹吸', '易损']);
  assert.deepEqual(offer.missingSlots, [], 'no slot may be reported missing');
  const gap = emitted.filter((event) => event.kind === 'augment_name_unknown');
  assert.equal(gap.length, 1, 'the catalogue gap is reported');
  assert.equal(gap[0].name, '神秘新强化');

  const dir = await mkdtemp(join(tmpdir(), 'jinbao-unknown-chain-'));
  let service;
  try {
    await mkdir(join(dir, 'logs'));
    const log = join(dir, 'logs/lol-unknown.jsonl');
    const at = Date.now() - 200;
    const base = { game: 'lol', match: 'unknown1' };
    await writeFile(log, JSON.stringify({ ...base, kind: 'load', t: at,
      me: { champion: '封魔剑魂', items: [] }, allies: [], enemies: [] }) + '\n');
    service = await createOverlayService({ stateDir: dir, pollMs: 20,
      agentChat: async () => { throw Object.assign(Error('no model'), { status: 503 }); },
      search: async () => ({ results: [] }) });
    await waitFor(() => service.view().game === 'lol', 'state applied');

    await appendFile(log, JSON.stringify({ ...base, kind: offer.kind, t: at + 100,
      roll: offer.roll, options: offer.options, missingSlots: offer.missingSlots ?? [] }) + '\n');
    await waitFor(() => service.view().augments.includes('神秘新强化'), 'the unknown card is listed on the panel');

    await appendFile(log, JSON.stringify({ ...base, kind: 'augment_picked', t: at + 200, roll: offer.roll,
      name: '神秘新强化', augment: '神秘新强化', who: 'self', source: 'vision-click', confidence: 'high' }) + '\n');
    await waitFor(() => String(service.view().advice).includes('神秘新强化'), 'the unknown card becomes owned');
  } finally {
    await service?.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
