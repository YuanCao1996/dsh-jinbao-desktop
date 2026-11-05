import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLearningNotice, toActivityRow } from '../lib/learning-notice.mjs';

test('a new lesson says what was learned and how much evidence it has', () => {
  const text = formatLearningNotice({ action: 'add', claim: '对面双坦先补重伤', evidence: { games: 3, hits: 3 } });
  assert.match(text, /记下一条经验/);
  assert.match(text, /对面双坦先补重伤/);
  assert.match(text, /3 局/);
});

test('strengthening shows the running record, not just an update', () => {
  const text = formatLearningNotice({ action: 'update', claim: '高光遮挡时先双帧比对', evidence: { games: 7, hits: 6 } });
  assert.match(text, /补充验证/);
  assert.match(text, /已验证 6\/7 局/);
});

test('a refutation or a player veto says it stops being used', () => {
  assert.match(formatLearningNotice({ action: 'dispute', claim: '第三件做法穿鞋' }), /不再注入/);
  const veto = formatLearningNotice({ action: 'correct', claim: '第三件做法穿鞋', by: 'player' });
  assert.match(veto, /按你的判断退役/);
  assert.match(veto, /你做的调整/);
});

test('an agent revision carries its reason and who made it', () => {
  const text = formatLearningNotice({ action: 'edit', claim: '五分钟后先退塔后等兵线', by: 'agent', reason: '14.21 该机制已改' });
  assert.match(text, /教练自行判断/);
  assert.match(text, /14\.21/);
});

test('empty claims produce no row, and rows keep an event time', () => {
  assert.equal(formatLearningNotice({ action: 'add' }), '');
  const row = toActivityRow({ action: 'add', claim: '甲经验' }, 1700000000000);
  assert.equal(row.kind, 'learn');
  assert.equal(row.at, 1700000000000);
  assert.match(row.text, /甲经验/);
});
