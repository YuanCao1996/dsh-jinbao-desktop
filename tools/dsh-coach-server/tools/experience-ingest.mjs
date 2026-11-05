#!/usr/bin/env node
// Ingest one finished match from an overlay state directory into the experience store.
//
// This is the offline door to the same pipeline the live coach will eventually call: it reads the
// logs we already write, derives only facts the logs can prove, distils at most three lessons and
// prints what would be injected next time. Running it after a real game is how the loop gets its
// first real data without waiting for the hot-path wiring.
//
// Usage: node experience-ingest.mjs <stateDir> [--outcome win|loss] [--player local] [--dry]

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createExperienceStore } from '../lib/experience-store.js';
import { createExperienceRuntime } from '../lib/experience-runtime.mjs';

export async function factsFromLogs(dir, { outcome = 'unknown' } = {}) {
  const logs = join(dir, 'logs');
  const names = await readdir(logs).catch(() => []);
  const facts = { game: 'lol', champion: '', match: '', deaths: 0, ended: false, outcome, recognition: { blindFrames: 0 } };
  const seen = new Set();
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const text = await readFile(join(logs, name), 'utf8').catch(() => '');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const me = event.me ?? event.state ?? {};
      if (event.match) facts.match = String(event.match);
      if (me.champion) facts.champion = String(me.champion);
      if (event.kind === 'augment_capture_blind') facts.recognition.blindFrames += 1;
      if (event.kind === 'death') facts.deaths += 1;
      if (event.kind === 'game_end' || event.ended === true || me.ended === true) facts.ended = true;
      // Death reminders we sent but that were followed by another death are the only "did it land"
      // signal the logs carry; dedupe by advice id so one reminder counts once.
      const adviceId = event.adviceId ?? event.key;
      if (event.kind === 'coach-advice' && adviceId && /阵亡|复活|death/i.test(String(event.key ?? ''))) {
        if (!seen.has(adviceId)) { seen.add(adviceId); facts.deathReminders = [...(facts.deathReminders ?? []), { adviceId }]; }
      }
    }
  }
  // A reminder is "ignored" when a later death happened after it; approximate by ordering.
  if (facts.deathReminders && facts.deaths > 0) {
    const ignored = Math.min(facts.deathReminders.length, Math.max(0, facts.deaths - 1));
    facts.deathReminders = facts.deathReminders.map((row, index) => ({ ...row, ignoredAfterReminder: index < ignored }));
  }
  return facts;
}

export async function ingest({ stateDir, outcome = 'unknown', player = 'local', patch = null, dry = false } = {}) {
  const facts = await factsFromLogs(stateDir, { outcome });
  if (!facts.ended) return { action: 'not-finished', facts };
  const store = createExperienceStore({ dir: join(stateDir, 'experience') });
  const runtime = createExperienceRuntime({ store, player, patch, enabled: !dry });
  const stored = await runtime.finish({ ...facts, player, patch });
  const pack = await runtime.pack({ tags: ['game:lol', ...(facts.champion ? [`champ:${facts.champion}`] : [])] });
  return { action: dry ? 'dry-run' : stored.action, facts, stored, pack };
}

if (process.argv[1]?.endsWith('experience-ingest.mjs')) {
  const stateDir = process.argv[2];
  const flag = (name, fallback = null) => {
    const index = process.argv.indexOf(name);
    return index > 0 ? process.argv[index + 1] : fallback;
  };
  if (!stateDir) {
    console.error('用法: node experience-ingest.mjs <stateDir> [--outcome win|loss] [--player local] [--dry]');
    process.exit(2);
  }
  const result = await ingest({
    stateDir,
    outcome: flag('--outcome', 'unknown'),
    player: flag('--player', 'local'),
    dry: process.argv.includes('--dry'),
  });
  console.log(JSON.stringify({ action: result.action, facts: result.facts, pack: result.pack }, null, 2));
}
