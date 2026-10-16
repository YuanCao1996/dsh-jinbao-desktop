const normalized = value => String(value ?? '').replace(/\s+/g, '').toLowerCase();
export const offerNames = offers => [...new Set((offers ?? []).map(value =>
  typeof value === 'string' ? value : value?.name).filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
export function heroMatches(row, champion) {
  const hero = normalized(row.champion), target = normalized(champion);
  return !!hero && !!target && (hero.includes(target) || target.includes(hero));
}
export function rankedAugments(rows, champion) {
  const rank = row => Number(row.rank) > 0 && Number.isFinite(Number(row.rank)) ? Number(row.rank) : Infinity;
  const tier = row => /^T\d+$/i.test(row.tier ?? '') ? Number(row.tier.slice(1)) : Infinity;
  const winRate = row => row.winRate != null && row.winRate !== '' && Number.isFinite(Number(row.winRate)) ? Number(row.winRate) : -1;
  const unique = new Map();
  for (const row of rows) if (row._type === 'augments' && heroMatches(row, champion) && row.name && !unique.has(row.name)) unique.set(row.name, row);
  return [...unique.values()].sort((a,b) => (rank(a)-rank(b) || tier(a)-tier(b) || winRate(b)-winRate(a) || a.name.localeCompare(b.name,'zh-CN')));
}
export function augmentLine(row) {
  const rank = Number(row.rank) > 0 && Number.isFinite(Number(row.rank)) ? '#'+Number(row.rank) : '排名暂无';
  const rate = row.winRate != null && row.winRate !== '' && Number.isFinite(Number(row.winRate)) ? Number(row.winRate)+'%' : '暂无';
  return [rank, row.name, row.tier, '胜率 '+rate].filter(Boolean).join(' · ');
}
