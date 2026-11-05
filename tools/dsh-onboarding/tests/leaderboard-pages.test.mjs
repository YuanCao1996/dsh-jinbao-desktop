import test from 'node:test';
import assert from 'node:assert/strict';
import {hextechLeaderboardPage, heroLeaderboardPage, topRuneId} from '../leaderboard-pages.mjs';

// 夹具取自生产真实返回（见 handoff/leaderboard-api.md）。

const hextech = [
  {rank: 1, tier: 'T1', name: '灵魂虹吸', winRate: 60.61, pickRate: 19.57, champion: '封魔剑魂 永恩'},
  {rank: 2, tier: 'T1', name: '升级：无尽之刃', winRate: 54.34, pickRate: 17.37, champion: '影哨 阿克尚'},
];

const heroes = [
  {rank: 1, name: '赫卡里姆', title: '战争之影', tier: 1, winRate: 58.1,
    augmentStats: '[{"augmentId":157,"rank":1},{"augmentId":17,"rank":2}]'},
  {rank: 2, name: '亚索', title: '疾风剑豪', tier: 2, winRate: 52.3, augmentStats: [{augmentId: 27, rank: 1}]},
];

test('海克斯总榜按列渲染：排名/品质/名称/胜率/选取率/适配英雄', () => {
  const page = hextechLeaderboardPage(hextech);
  const lines = page.split('\n');
  assert.match(lines[0], /通用 Top 海克斯 · 总榜（等待开局）/);
  assert.match(lines[2], /^#1 · T1 · 灵魂虹吸 · 胜率 60\.61% · 选取 19\.57% · 适配 封魔剑魂 永恩$/);
  assert.match(lines[3], /#2 · T1 · 升级：无尽之刃/);
});

test('英雄总榜按列渲染：排名/英雄名/称号/T级/胜率/顶级符文', () => {
  const page = heroLeaderboardPage(heroes, {topRune: (row) => (topRuneId(row) === 157 ? '灵魂虹吸' : topRuneId(row) === 27 ? '易损' : '')});
  const lines = page.split('\n');
  assert.match(lines[0], /英雄胜率总榜 · 大乱斗（等待开局）/);
  assert.match(lines[2], /^#1 · 赫卡里姆「战争之影」 · T1 · 胜率 58\.1% · 顶级符文 灵魂虹吸$/);
  assert.match(lines[3], /#2 · 亚索「疾风剑豪」 · T2 · 胜率 52\.3% · 顶级符文 易损/);
});

test('顶级符文取 augmentStats 里 rank 最小的一条，字符串与数组都支持', () => {
  assert.equal(topRuneId(heroes[0]), 157);
  assert.equal(topRuneId(heroes[1]), 27);
  assert.equal(topRuneId({augmentStats: '[]'}), null);
  assert.equal(topRuneId({augmentStats: 'not-json'}), null);
  assert.equal(topRuneId(null), null);
});

test('空数据返回空串，交给调用方退回原有文案', () => {
  assert.equal(hextechLeaderboardPage([]), '');
  assert.equal(heroLeaderboardPage(null), '');
});

test('limit 生效且缺失字段不炸', () => {
  const page = hextechLeaderboardPage([{name: '甲'}, {name: '乙'}], {limit: 1});
  const lines = page.split('\n');
  assert.equal(lines.length, 3, '标题两行 + 一条数据');
  assert.match(lines[2], /^#1 · — · 甲 · 胜率 — · 选取 —$/);
});
