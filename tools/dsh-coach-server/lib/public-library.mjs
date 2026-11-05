import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { toPublicLesson } from './public-lessons.mjs';

// Server-side storage for shared lessons.
//
// It is deliberately a plain file store: the whole point of sharing knowledge is that someone can
// read it. Markdown per kind for humans, one JSONL index for the API. No database, no player table,
// nothing that could be joined back to a person.
//
// Every incoming lesson is re-validated here even though the client already sanitised it: a server
// must not trust that the other side ran the right filter.

const DAY = 86400000;
const day = (stamp) => new Date(stamp).toISOString().slice(0, 10);

function confidenceOf(lesson) {
  const games = Number(lesson.evidence?.games) || 0;
  const hits = Number(lesson.evidence?.hits) || 0;
  const counter = Number(lesson.evidence?.counter) || 0;
  return Math.min(0.99, Math.max(0.05, (hits + 1) / (games + 2) - 0.15 * counter));
}

export function createPublicLibrary({ dir, now = Date.now } = {}) {
  if (!dir) throw new Error('public library needs a directory');
  const indexPath = join(dir, 'index.jsonl');
  let lessons = [];
  let loaded = false;

  async function load() {
    if (loaded) return lessons;
    try {
      const text = await readFile(indexPath, 'utf8');
      lessons = text.split('\n').filter((line) => line.trim()).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
    } catch {}
    loaded = true;
    return lessons;
  }

  async function flush() {
    await mkdir(dir, { recursive: true });
    const byKind = new Map();
    for (const lesson of lessons) {
      if (!byKind.has(lesson.kind)) byKind.set(lesson.kind, []);
      byKind.get(lesson.kind).push(
        `- [${confidenceOf(lesson).toFixed(2)}|${lesson.evidence?.games ?? 0}局|${lesson.patch ?? '未标注版本'}] ${lesson.claim}`,
      );
    }
    for (const [kind, lines] of byKind) {
      const sub = join(dir, 'public');
      await mkdir(sub, { recursive: true });
      await writeFile(join(sub, `${kind}.md`), lines.sort().join('\n') + '\n', 'utf8');
    }
    await writeFile(indexPath, lessons.map((lesson) => JSON.stringify(lesson)).join('\n') + (lessons.length ? '\n' : ''), 'utf8');
  }

  // Upsert, not append: the same fingerprint for the same patch is the same knowledge, so its
  // evidence accumulates. A refutation keeps the highest counter instead of being averaged away.
  async function upsert(incoming = []) {
    await load();
    const accepted = [];
    const rejected = [];
    let added = 0;
    let updated = 0;
    const stamp = Number(now());
    for (const candidate of incoming) {
      const checked = toPublicLesson(candidate);
      if (!checked.ok) { rejected.push({ fingerprint: candidate?.fingerprint ?? null, reason: checked.reason }); continue; }
      const lesson = checked.lesson;
      const same = lessons.find((row) => row.fingerprint === lesson.fingerprint && (row.patch ?? null) === (lesson.patch ?? null));
      if (!same) {
        lessons.push({
          ...lesson,
          firstSeen: day(stamp),
          lastSeen: day(stamp),
        });
        added += 1;
        accepted.push(lesson.fingerprint);
        continue;
      }
      same.evidence.games = (Number(same.evidence.games) || 0) + (Number(lesson.evidence.games) || 0);
      same.evidence.hits = (Number(same.evidence.hits) || 0) + (Number(lesson.evidence.hits) || 0);
      same.evidence.counter = Math.max(Number(same.evidence.counter) || 0, Number(lesson.evidence.counter) || 0);
      same.scope = [...new Set([...(same.scope ?? []), ...(lesson.scope ?? [])])].slice(0, 8);
      same.lastSeen = day(stamp);
      updated += 1;
      accepted.push(lesson.fingerprint);
    }
    if (accepted.length) await flush();
    return { accepted, rejected, added, updated, total: lessons.length };
  }

  async function query({ game = 'lol', patch = null, kind = null, limit = 50, minGames = 1 } = {}) {
    await load();
    const wanted = `game:${game}`;
    return lessons
      .filter((lesson) => (kind ? lesson.kind === kind : true))
      .filter((lesson) => (lesson.scope ?? []).includes(wanted))
      // Undated knowledge is still useful; dated knowledge from another patch is not.
      .filter((lesson) => !lesson.patch || !patch || lesson.patch === patch)
      .filter((lesson) => (Number(lesson.evidence?.games) || 0) >= minGames)
      .map((lesson) => ({ lesson, score: confidenceOf(lesson) * 2 + Math.log1p(Number(lesson.evidence?.games) || 0) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map((entry) => ({
        fingerprint: entry.lesson.fingerprint,
        kind: entry.lesson.kind,
        claim: entry.lesson.claim,
        scope: entry.lesson.scope,
        patch: entry.lesson.patch ?? null,
        evidence: entry.lesson.evidence,
        confidence: Number(confidenceOf(entry.lesson).toFixed(2)),
        lastSeen: entry.lesson.lastSeen,
      }));
  }

  async function prune({ staleDays = 180 } = {}) {
    await load();
    const cutoff = day(Number(now()) - staleDays * DAY);
    const before = lessons.length;
    // Unconfirmed knowledge that nobody has added to in half a year is more likely wrong than rare.
    lessons = lessons.filter((lesson) => (lesson.lastSeen ?? cutoff) >= cutoff || (Number(lesson.evidence?.hits) || 0) >= 5);
    if (lessons.length !== before) await flush();
    return { removed: before - lessons.length, total: lessons.length };
  }

  const stats = async () => {
    await load();
    const byKind = {};
    for (const lesson of lessons) byKind[lesson.kind] = (byKind[lesson.kind] ?? 0) + 1;
    return { total: lessons.length, byKind };
  };

  return { load, upsert, query, prune, stats, flush, indexFile: indexPath };
}
