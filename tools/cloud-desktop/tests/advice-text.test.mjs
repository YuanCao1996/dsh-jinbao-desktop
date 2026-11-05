import test from 'node:test';
import assert from 'node:assert/strict';
import {condenseAdvice} from '../advice-text.mjs';

// 真实数据：66 条播报平均 167 字、最长 533 字，35 条带段落。模型不会遵守"最多两句"，
// 所以播报正文在这里做确定性收敛。

test('多段落与 Markdown 被压成一句话之间', () => {
  const value = '**下一件优先：锯齿短匕**\n\n本局确认强化只有循环往复。\n\n该强化没有可核实数值，因此不当作伤害加成。';
  const out = condenseAdvice(value);
  assert.doesNotMatch(out, /\n/);
  assert.doesNotMatch(out, /\*\*/);
  assert.ok(out.length <= 68, out);
});

test('只保留前两句', () => {
  const out = condenseAdvice('先退到塔后。等锐雯大招落空再上前。血量低于四成先撤。');
  assert.equal(out, '先退到塔后。等锐雯大招落空再上前。');
});

test('超长单句截断在逗号处并补句号', () => {
  const long = '先清完兵线再跟队友进场，保留控制技能，等对面交出关键位移后再接团，然后立刻转中推塔，不要在中路纠缠太久以免被反打，也别在河道里等视野，回城补装备更稳';
  const out = condenseAdvice(long);
  assert.ok(out.length <= 68, out);
  assert.match(out, /。$/);
});

test('空输入与纯空白返回空串', () => {
  assert.equal(condenseAdvice(''), '');
  assert.equal(condenseAdvice('   \n\n '), '');
});

test('英文与分号同样被收敛', () => {
  const out = condenseAdvice('Push the wave first. Then recall; buy Wand.');
  assert.ok(!out.includes('\n'));
  assert.equal(out, 'Push the wave first. Then recall; buy Wand.');
});
