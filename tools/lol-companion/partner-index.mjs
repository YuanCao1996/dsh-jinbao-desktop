// Offline index of Hextech ARAM "best partner" pairs (101.qq.com 最佳拍档榜).
//
// The overlay renders during champion select with no model round-trip, so the data is
// bundled next to augment-names.json and read synchronously once per process.
// Champion names arrive in several forms between the live client, champ select and the
// dataset (称号 such as 疾风剑豪, 英雄名 such as 亚索, English alias such as Yasuo), so
// every known form is mapped to the dataset's champion id before lookup.

import { readFileSync } from 'node:fs';

let cache = null;

const empty = Object.freeze({ names: {}, partners: {} });

export function partnerIndex() {
  if (cache) return cache;
  try {
    cache = JSON.parse(readFileSync(new URL('./hextech-partners.json', import.meta.url), 'utf8'));
    if (!cache || typeof cache !== 'object') cache = empty;
  } catch {
    cache = empty; // A missing dataset must disable the feature, never break the overlay.
  }
  return cache;
}

const normalize = value => String(value ?? '').replace(/[\s·・.]/g, '').trim();

let resolved = null;
function lookup() {
  if (resolved) return resolved;
  const { names } = partnerIndex();
  const map = new Map();
  for (const [name, id] of Object.entries(names ?? {})) {
    const key = normalize(name);
    if (key && Number.isInteger(id)) map.set(key, id);
  }
  resolved = map;
  return map;
}

export function resolveChampionId(value) {
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric > 0 && partnerIndex().partners?.[String(numeric)]) return numeric;
  return lookup().get(normalize(value)) ?? null;
}

export function bestPartners(champion, { limit = 3 } = {}) {
  const id = resolveChampionId(champion);
  if (!id) return [];
  const rows = partnerIndex().partners?.[String(id)] ?? [];
  return rows.slice(0, Math.max(0, limit));
}

const percent = value => (typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) + '%' : '');

// Build the champion-select block. `picked` is the already-chosen champions of our own
// team; a partner that is already picked is marked so the value is obvious at a glance.
export function champSelectPartnerText(picked, { limit = 3, perChampion = 3 } = {}) {
  const index = partnerIndex();
  if (!index.partners || !Object.keys(index.partners).length) return '';
  const list = [...new Set((Array.isArray(picked) ? picked : []).map(value => String(value ?? '').trim()).filter(Boolean))];
  if (!list.length) return '';

  const pickedIds = new Set(list.map(resolveChampionId).filter(id => Number.isInteger(id)));
  const lines = [];
  let marked = false;

  for (const champion of list.slice(0, limit)) {
    const rows = bestPartners(champion, { limit: perChampion });
    if (!rows.length) continue;
    const cells = rows.map(row => {
      const already = pickedIds.has(row.id);
      if (already) marked = true;
      return `${row.name} ${percent(row.winRate)}${already ? '✓' : ''}`;
    });
    lines.push(`${champion}：${cells.join(' · ')}`);
  }
  if (!lines.length) return '';

  const scope = marked ? '（✓ 已在队内）' : '';
  return `最佳拍档 · 选人${scope}\n${lines.join('\n')}`;
}

export function partnerStatDate() {
  return partnerIndex().statDate ?? '';
}
