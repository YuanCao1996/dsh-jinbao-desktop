// 桌面版自带的私有经验读写。
//
// 不跨目录 import coach-server 的模块，避免打包器的静态扫描报错。
// 规则与主库一致：删掉或改写 = 退役（保留历史），手写新增从 1 局起算，未改动的证据不动。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PRIVATE_KINDS = new Set(['preference', 'correction', 'stats', 'pitfall', 'style']);
const LINE = /^\s*-\s*\[([^\]|]*)\|([^\]|]*)\|([^\]]*)\]\s*(.+?)\s*$/;

export function parseMd(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const match = LINE.exec(raw);
    if (!match) continue;
    out.push({
      confidence: Number(match[1]) || null,
      games: Number(String(match[2]).replace(/[^0-9.]/g, '')) || null,
      status: String(match[3]).trim() || 'candidate',
      claim: String(match[4]).trim(),
    });
  }
  return out;
}

const norm = (value) => String(value ?? '').replace(/\s+/g, '').toLowerCase();

export function createExperienceToolkit({ dir, player = 'local' } = {}) {
  if (!dir) throw new Error('experience toolkit needs a state directory');
  const base = join(dir, 'experience');
  const indexPath = join(base, 'index.jsonl');
  const mdPath = (kind) => join(base, 'private', player, kind + '.md');

  const loadIndex = async () => {
    try {
      const text = await readFile(indexPath, 'utf8');
      return text.split('\n').filter((line) => line.trim()).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
    } catch { return []; }
  };

  const saveIndex = async (records) => {
    await mkdir(join(base, 'private', player), { recursive: true });
    await writeFile(indexPath, records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''), 'utf8');
  };

  const readMd = async (kind) => {
    if (!PRIVATE_KINDS.has(kind)) throw new Error('private-only');
    return readFile(mdPath(kind), 'utf8').catch(() => '');
  };

  async function saveMd({ kind, mdText, by = 'player', reason = '' } = {}) {
    if (!PRIVATE_KINDS.has(kind)) return { ok: false, reason: 'private-only' };
    if (by === 'agent' && String(reason ?? '').trim().length < 4) return { ok: false, reason: 'reason-required' };
    if (!String(mdText ?? '').trim()) return { ok: false, reason: 'empty' };
    const records = await loadIndex();
    const shown = parseMd(mdText);
    const shownKeys = new Set(shown.map((entry) => norm(entry.claim)));
    const note = 'edited-by:' + (by === 'agent' ? 'agent' : 'player') + (reason ? ' | ' + String(reason).slice(0, 120) : '');
    let retired = 0;
    for (const record of records) {
      if (record.kind !== kind || !record.private || record.player !== player) continue;
      if (record.status === 'retired') continue;
      if (!shownKeys.has(norm(record.claim))) {
        record.status = 'retired';
        record.editNote = note;
        retired += 1;
      }
    }
    const known = new Set(records.filter((record) => record.kind === kind).map((record) => norm(record.claim)));
    let added = 0;
    for (const entry of shown) {
      if (known.has(norm(entry.claim))) continue;
      records.push({
        id: 'xp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        kind,
        claim: entry.claim,
        scope: [],
        private: true,
        player,
        patch: null,
        evidence: { games: 1, hits: 1, counter: 0 },
        status: 'candidate',
        updatedAt: Date.now(),
        editNote: note,
      });
      added += 1;
    }
    await saveIndex(records);
    const lines = records
      .filter((record) => record.kind === kind && record.private && record.player === player && record.status !== 'retired')
      .map((record) => {
        const games = record.evidence?.games ?? 1;
        const hits = record.evidence?.hits ?? 1;
        const confidence = (hits / Math.max(1, games + 1)).toFixed(2);
        return '- [' + confidence + '|' + games + '局|' + (record.status ?? 'candidate') + '] ' + record.claim;
      });
    await mkdir(join(base, 'private', player), { recursive: true });
    await writeFile(mdPath(kind), lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
    return { ok: true, retired, added, note };
  }

  async function editLine({ kind, from, to, reason = '' } = {}) {
    if (!PRIVATE_KINDS.has(kind)) return { ok: false, reason: 'private-only' };
    if (String(reason ?? '').trim().length < 4) return { ok: false, reason: 'reason-required' };
    if (!String(from ?? '').trim() || !String(to ?? '').trim()) return { ok: false, reason: 'empty' };
    const entries = parseMd(await readMd(kind));
    if (!entries.some((entry) => norm(entry.claim) === norm(from))) return { ok: false, reason: 'not-found' };
    const next = entries.map((entry) => (norm(entry.claim) === norm(from) ? { ...entry, claim: String(to).trim() } : entry));
    const mdText = next
      .map((entry) => '- [' + (entry.confidence ?? 0.5) + '|' + (entry.games ?? 1) + '局|' + entry.status + '] ' + entry.claim)
      .join('\n') + '\n';
    return saveMd({ kind, mdText, by: 'agent', reason });
  }

  const listPrivate = async () => (await loadIndex())
    .filter((record) => record.private && record.player === player && record.status !== 'retired')
    .map((record) => ({ id: record.id, kind: record.kind, claim: record.claim, evidence: record.evidence }));

  return { readMd, saveMd, editLine, listPrivate, privateKinds: [...PRIVATE_KINDS] };
}
