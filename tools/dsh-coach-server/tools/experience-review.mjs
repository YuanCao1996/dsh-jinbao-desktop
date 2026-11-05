#!/usr/bin/env node
// Review and veto what the experience store would inject next turn.
//
// This is the safety gate the whole "learn from every match" idea depends on: a lesson the player
// disagrees with must be demoted immediately, not argued with. The same two operations will back
// the settings page later, so they live here as plain functions first.
//
// Usage:
//   node experience-review.mjs <stateDir>                      # list
//   node experience-review.mjs <stateDir> --correct <id> --reason "这局对面没有双坦"
//   node experience-review.mjs <stateDir> --pack               # show the injected block

import { join } from 'node:path';
import { createExperienceStore } from '../lib/experience-store.js';

export function openStore(stateDir, options = {}) {
  return createExperienceStore({ dir: join(stateDir, 'experience'), ...options });
}

export async function listExperiences(stateDir) {
  const store = openStore(stateDir);
  const rows = await store.load();
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    claim: row.claim,
    scope: row.scope,
    private: Boolean(row.private),
    evidence: row.evidence,
    status: row.status ?? 'candidate',
  }));
}

export async function correctExperience(stateDir, id, reason = '') {
  const store = openStore(stateDir);
  const result = await store.correct(id, reason);
  return result;
}

export async function previewPack(stateDir, { tags = ['game:lol'], patch = null } = {}) {
  const store = openStore(stateDir);
  const pack = await store.retrieve({ tags, patch });
  return pack;
}

if (process.argv[1]?.endsWith('experience-review.mjs')) {
  const stateDir = process.argv[2];
  const flag = (name, fallback = null) => {
    const index = process.argv.indexOf(name);
    return index > 0 ? process.argv[index + 1] : fallback;
  };
  if (!stateDir) {
    console.error('用法: node experience-review.mjs <stateDir> [--pack] [--correct <id> --reason <原因>]');
    process.exit(2);
  }
  if (process.argv.includes('--pack')) {
    const pack = await previewPack(stateDir, { tags: (flag('--tags', 'game:lol') ?? 'game:lol').split(','), patch: flag('--patch') });
    console.log(JSON.stringify({ chars: pack.chars, ids: pack.ids, lines: pack.lines }, null, 2));
  } else if (flag('--correct')) {
    const result = await correctExperience(stateDir, flag('--correct'), flag('--reason', ''));
    console.log(JSON.stringify(result, null, 2));
  } else {
    const rows = await listExperiences(stateDir);
    if (!rows.length) console.log('（还没有经验；打完一局后会自动生成）');
    for (const row of rows) {
      const badge = row.private ? '私有' : '公有';
      console.log(`${row.id}  [${row.kind}|${badge}|${row.status}]  ${row.evidence?.hits ?? 0}/${row.evidence?.games ?? 0}局  ${row.claim}`);
    }
  }
}
