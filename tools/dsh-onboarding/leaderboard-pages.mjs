// 等待态的"总榜"两页渲染：海克斯榜与英雄胜率榜。
//
// 数据来自桌面网关的整榜接口（契约见 handoff/leaderboard-api.md）：
//   POST /desktop/agent-preview/knowledge
//   {game:'lol', query, dataset:'leaderboard', board:'hextech'|'heroes', limit:1..20}
//
// 这两页只在"没进对局/没选到英雄"时显示，所以标题必须写明是总榜、并且标注数据来源是
// 快照，避免玩家把它当成本局数据。任何一页拿不到数据时返回空串，由调用方退回原有文案。

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
const pct = (value) => {
  const n = num(value);
  return n === null ? '—' : (Math.round(n * 100) / 100).toString() + '%';
};

/** 品质列：海克斯数据是 'T1' 这类字符串，英雄数据是数字 1/2/3。 */
const quality = (value) => {
  if (value === null || value === undefined || value === '') return '—';
  const text = String(value).trim();
  return /^[Tt]/.test(text) ? text.toUpperCase() : 'T' + text;
};

export function hextechLeaderboardPage(rows, { limit = 10 } = {}) {
  const list = Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object') : [];
  if (!list.length) return '';
  const lines = ['通用 Top 海克斯 · 总榜（等待开局）', '数据为快照口径，进入对局后自动切换为本局英雄'];
  list.slice(0, limit).forEach((row, index) => {
    const rank = num(row.rank) ?? index + 1;
    const champion = typeof row.champion === 'string' && row.champion ? ' · 适配 ' + row.champion : '';
    lines.push(`#${rank} · ${quality(row.tier)} · ${row.name ?? '—'} · 胜率 ${pct(row.winRate)} · 选取 ${pct(row.pickRate)}${champion}`);
  });
  return lines.join('\n');
}

export function heroLeaderboardPage(rows, { limit = 10, topRune } = {}) {
  const list = Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object') : [];
  if (!list.length) return '';
  const lines = ['英雄胜率总榜 · 大乱斗（等待开局）', '数据为快照口径，进入对局后自动切换为本局双方英雄'];
  list.slice(0, limit).forEach((row, index) => {
    const rank = num(row.rank) ?? index + 1;
    const name = [row.name, row.title ? `「${row.title}」` : ''].filter(Boolean).join('') || '—';
    const rune = typeof topRune === 'function' ? topRune(row) : '';
    lines.push(`#${rank} · ${name} · ${quality(row.tier)} · 胜率 ${pct(row.winRate)}${rune ? ' · 顶级符文 ' + rune : ''}`);
  });
  return lines.join('\n');
}

/** 从英雄行里取"顶级符文"对应的强化 id（数据里 augmentStats 是 JSON 字符串或数组）。 */
export function topRuneId(row) {
  if (!row) return null;
  let stats = row.augmentStats;
  if (typeof stats === 'string') {
    try {
      stats = JSON.parse(stats);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(stats) || !stats.length) return null;
  const first = stats.slice().sort((a, b) => (num(a?.rank) ?? 999) - (num(b?.rank) ?? 999))[0];
  const id = num(first?.augmentId);
  return id === null ? null : id;
}
