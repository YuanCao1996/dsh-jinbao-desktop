import test from 'node:test';
import assert from 'node:assert/strict';
import {mapPickedSlot} from '../augment-map.mjs';

// A real match read the panel as [屹立不倒, 尖端发明家, 质变：棱彩阶] but the offer only carried
// slots 1 and 2. The watcher correctly reported slot 0; the old positional fallback then named
// it 尖端发明家 — the neighbouring card. These pin that a gap is reported, never guessed.

test('a slot the offer captured maps to its own card', () => {
  const options = [{ slot: 0, name: '更万用的瞄准镜' }, { slot: 1, name: '灵魂虹吸' }, { slot: 2, name: '豪猪' }];
  assert.deepEqual(mapPickedSlot(options, 1), { name: '灵魂虹吸' });
  assert.deepEqual(mapPickedSlot(options, 0), { name: '更万用的瞄准镜' });
  assert.deepEqual(mapPickedSlot(options, 2), { name: '豪猪' });
});

test('a slot the offer never captured is reported as missing, not shifted', () => {
  const partial = [{ slot: 1, name: '尖端发明家' }, { slot: 2, name: '质变：棱彩阶' }];
  assert.deepEqual(mapPickedSlot(partial, 0), { name: null, missing: true });
  assert.deepEqual(mapPickedSlot(partial, 1), { name: '尖端发明家' });
});

test('an empty or unknown slot is missing rather than silently naming a neighbour', () => {
  assert.deepEqual(mapPickedSlot([], 0), { name: null, missing: true });
  assert.deepEqual(mapPickedSlot([{ slot: 2, name: '豪猪' }], 5), { name: null, missing: true });
  assert.deepEqual(mapPickedSlot([{ slot: 0 }], 0), { name: null, missing: true });
});

test('legacy name lists without slot numbers still map by position', () => {
  assert.deepEqual(mapPickedSlot(['甲', '乙', '丙'], 2), { name: '丙' });
  assert.deepEqual(mapPickedSlot([{ name: '甲' }, { name: '乙' }], 0), { name: '甲' });
  assert.equal(mapPickedSlot(['甲'], 3), null);
});

test('a non-integer pick is not a slot', () => {
  assert.equal(mapPickedSlot([{ slot: 0, name: '甲' }], null), null);
  assert.equal(mapPickedSlot([{ slot: 0, name: '甲' }], -1), null);
  assert.equal(mapPickedSlot([{ slot: 0, name: '甲' }], '1'), null);
});
