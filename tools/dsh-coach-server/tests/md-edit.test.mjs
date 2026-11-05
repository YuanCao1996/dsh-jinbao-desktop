import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMd, diffMd, editNote } from '../lib/md-edit.mjs';

const md = (...lines) => ['# 备注行会被忽略', ...lines].join('\n');
const record = (claim, games = 5) => ({ id: claim, claim, evidence: { games, hits: games, counter: 0 } });

test('md lines parse into entries and junk is ignored', () => {
  const entries = parseMd(md('- [0.86|5局|public] 高光遮挡时先取前后两帧比对', '- 这行没有方括号', '- [0.40|2局|candidate] 对面双坦先补重伤'));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].confidence, 0.86);
  assert.equal(entries[0].games, 5);
  assert.equal(entries[0].status, 'public');
  assert.equal(entries[1].claim, '对面双坦先补重伤');
});

test('editing a line retires the old lesson instead of erasing its evidence', () => {
  const records = [record('对面双坦先补重伤'), record('高光遮挡时先取前后两帧比对')];
  const result = diffMd({ mdText: md('- [0.86|5局|public] 高光遮挡时先取前后两帧比对', '- [0.30|1局|candidate] 对面双坦先补法穿'), records });
  assert.deepEqual(result.kept.map((row) => row.id), ['高光遮挡时先取前后两帧比对']);
  assert.deepEqual(result.retired.map((row) => row.id), ['对面双坦先补重伤']);
  assert.equal(result.added.length, 1);
  assert.equal(result.added[0].claim, '对面双坦先补法穿');
});

test('deleting a line and adding a new one both work', () => {
  const records = [record('旧经验甲'), record('旧经验乙')];
  const result = diffMd({ mdText: md('- [0.50|3局|candidate] 旧经验甲', '- [0.20|1局|candidate] 新经验丙'), records });
  assert.deepEqual(result.kept.map((row) => row.id), ['旧经验甲']);
  assert.deepEqual(result.retired.map((row) => row.id), ['旧经验乙']);
  assert.equal(result.added[0].claim, '新经验丙');
});

test('an untouched md changes nothing', () => {
  const records = [record('甲'), record('乙')];
  const text = md('- [0.5|2局|candidate] 甲', '- [0.6|3局|candidate] 乙');
  const result = diffMd({ mdText: text, records });
  assert.equal(result.kept.length, 2);
  assert.equal(result.retired.length, 0);
  assert.equal(result.added.length, 0);
});

test('edits carry who made them so they can be audited', () => {
  assert.match(editNote({ by: 'player' }), /edited-by:player/);
  assert.match(editNote({ by: 'agent', reason: '这个版本的护盾已改' }), /edited-by:agent.*护盾已改/);
});
