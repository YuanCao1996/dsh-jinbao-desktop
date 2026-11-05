import { createHash } from 'node:crypto';
import { claimSimilarity } from './experience-store.js';

// Public lessons live on the server and must never carry who learned them.
//
// Two rules make that enforceable rather than aspirational:
//   1. anything player-shaped is refused here, before it can be queued for upload;
//   2. free text goes through stripIdentity, so a lesson that quoted a champion name is fine while
//      "刚才 @小明 说的那个" is not.
//
// The server stores only: kind, claim, scope tags, patch, evidence counters, fingerprint.
// No player id, no machine id, no timestamps finer than the day.

export const PUBLIC_KINDS = new Set([
  'recognition', 'tool-failure', 'retrieval-web', 'retrieval-local', 'knowledge', 'strategy', 'build', 'dispute',
]);
const PRIVATE_KINDS = new Set(['preference', 'correction', 'stats', 'pitfall', 'style']);

// Shapes that could identify a person: @mentions, Riot ID (name#tag), long digit runs, phone numbers,
// and quoted speech (which is where names usually sneak in).
const IDENTITY_PATTERNS = [
  /@[^\s，。；、]+/g,
  /[A-Za-z0-9_]{3,}#[A-Za-z0-9]{3,}/g,
  /\b1\d{10}\b/g,
  /\b\d{6,}\b/g,
  /[“"「][^”"」]{4,}[”"」]/g,
];

export function stripIdentity(text) {
  let value = String(text ?? '');
  for (const pattern of IDENTITY_PATTERNS) value = value.replace(pattern, '');
  return value.replace(/\s{2,}/g, ' ').trim();
}

export function claimFingerprint(claim) {
  return createHash('sha1').update(String(claim ?? '').replace(/\s+/g, '').toLowerCase()).digest('hex').slice(0, 16);
}

const cleanScope = (scope) => (scope ?? [])
  .map(String)
  // A player tag would turn a shared lesson into a personal one. Drop it instead of uploading.
  .filter((tag) => !/^(player|user|uid):/i.test(tag));

/**
 * Convert a local record into the exact shape the server stores, or explain why it cannot be shared.
 * @returns {{ok: true, lesson: object} | {ok: false, reason: string}}
 */
export function toPublicLesson(record) {
  if (!record || typeof record !== 'object') return { ok: false, reason: 'not-a-record' };
  // Report the most specific reason: a stats record is private because of its kind, not merely
  // because the caller forgot to clear the player field.
  if (record.private === true) return { ok: false, reason: 'private-record' };
  if (PRIVATE_KINDS.has(record.kind)) return { ok: false, reason: 'private-kind' };
  if (record.player) return { ok: false, reason: 'player-tagged' };
  if (!PUBLIC_KINDS.has(record.kind)) return { ok: false, reason: 'unknown-kind' };
  const claim = stripIdentity(record.claim);
  if (claim.length < 4) return { ok: false, reason: 'empty-claim' };
  const evidence = {
    games: Math.max(0, Number(record.evidence?.games) || 0),
    hits: Math.max(0, Number(record.evidence?.hits) || 0),
    counter: Math.max(0, Number(record.evidence?.counter) || 0),
  };
  return {
    ok: true,
    lesson: {
      fingerprint: claimFingerprint(claim),
      kind: record.kind,
      claim,
      scope: cleanScope(record.scope),
      patch: record.patch ? String(record.patch) : null,
      evidence,
    },
  };
}

export function toPublicLessons(records = []) {
  const lessons = [];
  const rejected = [];
  for (const record of records) {
    const converted = toPublicLesson(record);
    if (converted.ok) lessons.push(converted.lesson);
    else rejected.push({ id: record?.id ?? null, reason: converted.reason });
  }
  return { lessons, rejected };
}

/**
 * Merge a fetched public lesson into the local set: same fingerprint means same knowledge, so the
 * counters add up instead of the list growing. A different patch keeps both — a balance change is a
 * real difference, not a duplicate.
 */
export function mergePublicLessons(local = [], remote = []) {
  const merged = local.map((row) => ({ ...row, evidence: { ...row.evidence } }));
  let added = 0;
  let updated = 0;
  for (const incoming of remote) {
    const same = merged.find((row) => row.kind === incoming.kind
      && (row.patch ?? null) === (incoming.patch ?? null)
      && (row.fingerprint === incoming.fingerprint || claimSimilarity(row.claim, incoming.claim) >= 0.9));
    if (!same) {
      merged.push({ ...incoming, evidence: { ...incoming.evidence } });
      added += 1;
      continue;
    }
    same.evidence.games += Number(incoming.evidence?.games) || 0;
    same.evidence.hits += Number(incoming.evidence?.hits) || 0;
    same.evidence.counter = Math.max(same.evidence.counter, Number(incoming.evidence?.counter) || 0);
    same.scope = [...new Set([...(same.scope ?? []), ...(incoming.scope ?? [])])].slice(0, 8);
    updated += 1;
  }
  return { lessons: merged, added, updated };
}
