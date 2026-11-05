import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { toPublicLessons } from './public-lessons.mjs';
import { claimSimilarity } from './experience-store.js';

// Client half of the shared library.
//
// Two rules keep this honest:
//   1. upload goes through toPublicLessons, so nothing player-shaped can leave the machine;
//   2. download never double counts. Remote lessons carry cumulative evidence, and we record which
//      (fingerprint, patch) pairs we already merged, so pulling twice cannot inflate a lesson's
//      confidence — that would let a client "vote twice" just by syncing often.

const SYNC_FILE = 'public-sync.json';

async function readSyncState(dir) {
  try {
    const text = await readFile(join(dir, SYNC_FILE), 'utf8');
    const value = JSON.parse(text);
    return { merged: Array.isArray(value.merged) ? value.merged : [], lastSyncAt: Number(value.lastSyncAt) || 0 };
  } catch {
    return { merged: [], lastSyncAt: 0 };
  }
}

async function writeSyncState(dir, state) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, SYNC_FILE), JSON.stringify(state), 'utf8');
}

const keyOf = (lesson) => `${lesson.fingerprint}@${lesson.patch ?? 'undated'}`;

/** Local lessons that are allowed to leave this machine. */
export async function uploadCandidates(store) {
  const records = await store.load();
  const { lessons, rejected } = toPublicLessons(records);
  return { lessons, rejected };
}

/**
 * Merge fetched lessons into the local store.
 * Remote evidence is cumulative, so a lesson merged once is not merged again.
 */
export async function mergeRemote(store, dir, fetched = []) {
  const state = await readSyncState(dir);
  const seen = new Set(state.merged);
  let merged = 0;
  let skipped = 0;
  const applied = [];
  for (const lesson of fetched) {
    const claimed = lesson?.claim;
    if (!claimed || !lesson?.fingerprint) { skipped += 1; continue; }
    const key = keyOf(lesson);
    if (seen.has(key)) { skipped += 1; continue; }
    // Local lessons already close enough to the remote one keep their own evidence; the store's
    // update path adds the remote totals once, which is exactly what a first merge should do.
    await store.remember({
      kind: lesson.kind,
      claim: String(claimed).slice(0, 240),
      scope: lesson.scope ?? [],
      patch: lesson.patch ?? null,
      evidence: lesson.evidence ?? { games: 1, hits: 1, counter: 0 },
      private: false,
    });
    seen.add(key);
    applied.push(lesson.fingerprint);
    merged += 1;
  }
  if (merged) {
    state.merged = [...seen];
    state.lastSyncAt = Date.now();
    await writeSyncState(dir, state);
  }
  return { merged, skipped, applied };
}

/** How similar two lessons are, re-exported so callers do not need the store internals. */
export const sameLesson = (left, right) => claimSimilarity(left?.claim ?? '', right?.claim ?? '') >= 0.9;
