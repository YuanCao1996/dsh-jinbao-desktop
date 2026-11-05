import { distillMatch } from './experience-distill.js';
import { experienceSection } from './experience-store.js';

// Glue between the match lifecycle and the experience store.
//
// Two responsibilities only:
//   finish(facts)  – after a match, distil at most three lessons and merge them into the store
//   pack(query)    – before a turn, build the bounded prompt block for the current scope
//
// It deliberately owns no game logic: the caller passes facts it already has, so this layer can
// be tested without a match, a window, or a model.

const seenMatches = new Set();

export function createExperienceRuntime({ store, enabled = true, player = 'local', patch = null, now = Date.now } = {}) {
  if (!store) throw new Error('experience runtime needs a store');

  // One match must be distilled once. The poll loop sees "ended" on every tick, and without this
  // guard a single game would keep adding evidence to its own champion record forever.
  async function finish(facts = {}) {
    if (!enabled) return { action: 'disabled', stored: 0 };
    const match = facts.match ? String(facts.match) : '';
    if (match && seenMatches.has(match)) return { action: 'duplicate', stored: 0 };
    const candidates = distillMatch({ ...facts, player: facts.player ?? player, patch: facts.patch ?? patch })
      // A win/loss we do not know would otherwise be logged as a miss and drag the record down.
      .filter((candidate) => candidate.kind !== 'stats' || candidate.evidence.hits !== undefined && ['win', 'loss'].includes(facts.outcome));
    const results = [];
    for (const candidate of candidates) results.push(await store.remember(candidate));
    if (match) seenMatches.add(match);
    return { action: 'stored', stored: results.filter((row) => row.action !== 'rejected').length, results };
  }

  async function pack({ tags = [], queryPatch = patch, maxChars = null } = {}) {
    if (!enabled) return { section: '', ids: [], chars: 0 };
    const recalled = await store.retrieve({ tags, player, patch: queryPatch ?? null });
    const section = experienceSection(recalled);
    if (!maxChars || section.length <= maxChars) return { section, ids: recalled.ids, chars: section.length };
    // Hard cap: even the store's own budget can be tightened by the caller that owns the window.
    // Lines are dropped from the tail until the *rendered* block (heading included) fits.
    const clipped = recalled.lines.filter((line) => line.length <= maxChars).slice(0, 4);
    let trimmed = experienceSection({ lines: clipped });
    while (clipped.length && trimmed.length > maxChars) {
      clipped.pop();
      trimmed = experienceSection({ lines: clipped });
    }
    return { section: trimmed, ids: recalled.ids.slice(0, clipped.length), chars: trimmed.length };
  }

  const status = () => ({ enabled, player, patch, matches: seenMatches.size, stamp: Number(now()) });

  return { finish, pack, status };
}
