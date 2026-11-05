import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { diffMd, editNote } from './md-edit.mjs';
import { join } from 'node:path';

// Experience store: the "learn from every match" layer.
//
// Design follows three open-source ideas, deliberately without their weight:
//  - mem0: writes are a decision (add / update / noop / dispute), never a blind append;
//  - Graphiti/Zep: every record is double-temporal (which patch it was true for, when we
//    last confirmed it), so a balance change can retire advice instead of silently poisoning it;
//  - Basic Memory: the durable form is markdown, regenerated from the index, so a human can
//    read and audit everything that will be injected into a prompt.

const KINDS = new Set([
  'recognition', 'knowledge', 'retrieval-web', 'retrieval-local', 'strategy', 'build',
  'dispute', 'tool-failure', 'preference', 'correction', 'stats', 'pitfall', 'style',
]);
// Anything that describes the player rather than the game stays local and only loads for
// that player; a shared library must never carry one person's habits.
const PRIVATE_KINDS = new Set(['preference', 'correction', 'stats', 'pitfall', 'style']);

const SCOPE_WEIGHT = { champ: 4, aug: 4, comp: 3, game: 2, event: 2, phase: 1, intent: 1, player: 1 };
const SAME_CLAIM = 0.75;

const normalize = (value) => String(value ?? '').replace(/\s+/g, '').toLowerCase();
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function bigrams(text) {
  const value = normalize(text);
  const out = new Set();
  for (let index = 0; index < value.length - 1; index += 1) out.add(value.slice(index, index + 2));
  return out;
}

// Chinese has no word boundaries, so character bigrams are the cheapest reliable similarity.
export function claimSimilarity(left, right) {
  const a = bigrams(left);
  const b = bigrams(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return shared / Math.max(a.size, b.size);
}

function confidenceOf(record) {
  const games = Math.max(0, Number(record.evidence?.games) || 0);
  const hits = Math.max(0, Number(record.evidence?.hits) || 0);
  const counter = Math.max(0, Number(record.evidence?.counter) || 0);
  // Laplace smoothed hit rate, penalised per refutation: one counter stays visible instead of
  // being averaged away, which is what makes learning from mistakes different from flattery.
// Note: the packager walks import-like text, so comments must never quote a module specifier.
  return clamp((hits + 1) / (games + 2) - 0.15 * counter, 0.05, 0.99);
}

function statusOf(record) {
  // 退役是终态：md 里删掉的条目不能被一次重新计算又"复活"，否则用户改了也不生效。
  if (record.status === 'retired') return 'retired';
  const games = Number(record.evidence?.games) || 0;
  const counter = Number(record.evidence?.counter) || 0;
  const hits = Number(record.evidence?.hits) || 0;
  // A refutation that matches the number of confirmations means we no longer know: demote.
  // A well-established lesson (five confirmations, one refutation) merely loses confidence.
  if (counter > 0 && counter >= hits) return 'stale';
  return games >= 5 ? 'public' : 'candidate';
}

// Prompt block for one turn. The heading matters: the model must treat these as history and
// never as a description of the current match, otherwise an old habit can overwrite live facts.
export function experienceSection(pack) {
  const lines = (pack?.lines ?? []).filter(Boolean);
  if (!lines.length) return '';
  return ['【历史经验｜仅作参考，不覆盖本局事实】', ...lines].join('\n');
}

export function createExperienceStore({ dir, now = Date.now, maxItems = 8, budgetChars = 400 } = {}) {
  if (!dir) throw new Error('experience store needs a directory');
  const indexPath = join(dir, 'index.jsonl');
  const records = [];
  let loaded = false;

  const stamp = () => Number(now());

  async function load() {
    if (loaded) return records;
    try {
      const text = await readFile(indexPath, 'utf8');
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const record = JSON.parse(trimmed);
          if (record?.id && record?.claim && KINDS.has(record.kind)) records.push(record);
        } catch {}
      }
    } catch {}
    loaded = true;
    return records;
  }

  // Markdown mirror, regenerated on save: public shards, then one private shard per player.
  async function flush() {
    await mkdir(join(dir, 'public'), { recursive: true });
    await mkdir(join(dir, 'private'), { recursive: true });
    const shards = new Map();
    for (const record of records) {
      const key = record.private ? `private/${record.player ?? 'me'}/${record.kind}.md` : `public/${record.kind}.md`;
      if (!shards.has(key)) shards.set(key, []);
      const conf = confidenceOf(record).toFixed(2);
      const games = Number(record.evidence?.games) || 0;
      shards.get(key).push(`- [${conf}|${games}局|${record.status}] ${record.claim}`);
    }
    for (const [key, lines] of shards) {
      const path = join(dir, key);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, lines.sort().join('\n') + '\n', 'utf8');
    }
    await writeFile(indexPath, records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''), 'utf8');
  }

  function match(record, candidate) {
    return claimSimilarity(record.claim, candidate.claim) >= SAME_CLAIM;
  }

  // A write is a decision. Returning the action makes the caller (and its tests) able to see
  // whether a lesson was learned, refined, ignored, or contradicted.
  async function remember(candidate) {
    await load();
    if (!candidate?.claim || !KINDS.has(candidate.kind)) return { action: 'rejected', reason: 'kind-or-claim' };
    const privateKind = candidate.private ?? PRIVATE_KINDS.has(candidate.kind);
    if (privateKind && !candidate.player) return { action: 'rejected', reason: 'private-needs-player' };
    const record = {
      id: candidate.id ?? `xp-${String(stamp()).slice(-6)}-${Math.random().toString(36).slice(2, 6)}`,
      kind: candidate.kind,
      claim: String(candidate.claim).trim().slice(0, 240),
      scope: [...new Set((candidate.scope ?? []).map(String))].slice(0, 8),
      private: Boolean(privateKind),
      player: candidate.player ?? null,
      patch: candidate.patch ?? null,
      evidence: {
        games: Math.max(1, Number(candidate.evidence?.games) || 1),
        hits: Math.max(0, Number(candidate.evidence?.hits) || 1),
        counter: Math.max(0, Number(candidate.evidence?.counter) || 0),
      },
      validFrom: candidate.validFrom ?? stamp(),
      updatedAt: stamp(),
    };
    const existing = records.find((row) => row.kind === record.kind
      && row.private === record.private
      && (row.player ?? null) === (record.player ?? null)
      && match(row, record));
    if (!existing) {
      record.status = statusOf(record);
      records.push(record);
      await flush();
      return { action: 'add', id: record.id };
    }
    if (candidate.disputes === existing.id || candidate.counter === true) {
      existing.evidence.counter += 1;
      existing.evidence.games += 1;
      existing.updatedAt = stamp();
      existing.status = statusOf(existing);
      await flush();
      return { action: 'dispute', id: existing.id, status: existing.status };
    }
    // Same lesson seen again: strengthen the evidence, never duplicate the line.
    // A sighting with an explicit zero hit (a loss) must stay a miss instead of defaulting to 1.
    const addHits = candidate.evidence?.hits === undefined ? 1 : Math.max(0, Number(candidate.evidence.hits) || 0);
    existing.evidence.games += Math.max(1, Number(candidate.evidence?.games) || 1);
    existing.evidence.hits += addHits;
    existing.scope = [...new Set([...existing.scope, ...record.scope])].slice(0, 8);
    if (record.patch) existing.patch = record.patch;
    existing.updatedAt = stamp();
    existing.status = statusOf(existing);
    await flush();
    return { action: 'update', id: existing.id };
  }

  function scopeScore(record, tags) {
    let score = 0;
    for (const tag of record.scope) {
      const kind = tag.split(':')[0];
      if (tags.has(tag)) score += SCOPE_WEIGHT[kind] ?? 1;
    }
    return score;
  }

  // Build the experience pack for one turn: highest (relevance x confidence x freshness) first,
  // stop at the character budget so a long memory can never crowd out the actual match facts.
  async function retrieve({ tags = [], player = null, patch = null } = {}) {
    await load();
    const wanted = new Set(tags.map(String));
    const fresh = (record) => {
      if (record.status === 'stale' || record.status === 'retired') return false;
      if (record.patch && patch && record.patch !== patch) return false;
      return true;
    };
    const candidates = records
      .filter((record) => fresh(record))
      .filter((record) => (record.private ? record.player === player : true))
      .map((record) => {
        const relevance = scopeScore(record, wanted);
        const confidence = confidenceOf(record);
        const ageDays = Math.max(0, (stamp() - Number(record.updatedAt || 0)) / 86400000);
        return { record, score: relevance * 2 + confidence * 3 - Math.min(1.5, ageDays / 30) };
      })
      .filter((item) => item.score > 0.6)
      .sort((left, right) => right.score - left.score);
    const picked = [];
    let used = 0;
    for (const item of candidates) {
      if (picked.length >= maxItems) break;
      const line = `[${item.record.kind}|${confidenceOf(item.record).toFixed(2)}|${Number(item.record.evidence?.games) || 0}局] ${item.record.claim}`;
      if (used + line.length + 1 > budgetChars) continue;
      used += line.length + 1;
      picked.push({ id: item.record.id, line });
    }
    return { lines: picked.map((item) => item.line), ids: picked.map((item) => item.id), chars: used };
  }

  // md 编辑写回：玩家改自己的私有 md、agent 修订过期条目，都从这里落地。
  // 规则：删掉/改写的旧条目退役（保留历史），新增行从 1 局起算，未改动的证据不受影响。
  async function applyMdEdit({ kind, player = null, mdText, by = 'player', reason = '' } = {}) {
    await load();
    const scope = records.filter((record) => record.kind === kind
      && (record.private ? record.player === player : true)
      && !(record.status === 'retired')
      && !(record.status === 'stale'));
    const { retired, added } = diffMd({ mdText, records: scope });
    const note = editNote({ by, reason });
    for (const record of retired) {
      record.status = 'retired';
      record.retiredAt = stamp();
      record.editNote = note;
    }
    for (const entry of added) {
      const games = 1;
      records.push({
        id: `xp-${String(stamp()).slice(-6)}-${Math.random().toString(36).slice(2, 6)}`,
        kind, claim: entry.claim, scope: [],
        private: PRIVATE_KINDS.has(kind), player: PRIVATE_KINDS.has(kind) ? player : null,
        patch: null,
        evidence: { games, hits: games, counter: 0 },
        validFrom: stamp(), updatedAt: stamp(),
        status: 'candidate',
        editNote: note,
      });
    }
    await flush();
    return { retired: retired.length, added: added.length, note };
  }

  // The player saying "that is wrong" is the strongest signal the system ever gets.
  async function correct(id, reason = '') {
    await load();
    const record = records.find((row) => row.id === id);
    if (!record) return { ok: false, reason: 'not-found' };
    record.evidence.counter += 1;
    record.updatedAt = stamp();
    record.status = statusOf(record);
    record.correction = String(reason).slice(0, 120);
    await flush();
    return { ok: true, status: record.status };
  }

  const snapshot = () => records.map((record) => ({
    id: record.id,
    kind: record.kind,
    claim: record.claim,
    scope: record.scope,
    private: record.private,
    status: statusOf(record),
    confidence: Number(confidenceOf(record).toFixed(2)),
    evidence: record.evidence,
  }));

  return { load, remember, retrieve, correct, applyMdEdit, snapshot, indexFile: indexPath };
}
