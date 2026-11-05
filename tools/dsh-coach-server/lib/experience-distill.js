// Post-match distillation: turn one finished game into at most three experience candidates.
//
// Deliberately conservative. Only signals we can actually verify from our own logs are used:
// what the game ended as, how often the player died, whether a death reminder was followed by
// another death anyway, and whether augment recognition was blind for a long stretch.
// We do NOT attribute an item purchase to a win: we have no counterfactual, and guessing here is
// exactly how a "self improving" system starts confidently learning wrong lessons.
//
// Public lessons only come from recognition/tooling evidence (true regardless of who played).
// Anything about this specific player is private.

const PUBLIC_KINDS = new Set(['recognition', 'tool-failure', 'retrieval-web', 'retrieval-local']);
export const MAX_LESSONS = 3;

const has = (value) => value !== null && value !== undefined && value !== '';

/**
 * @param facts {
 *   game, patch, champion, outcome: 'win'|'loss'|'unknown',
 *   deaths?: number,
 *   deathReminders?: Array<{ ignoredAfterReminder?: boolean }>,
 *   recognition?: { blindFrames?: number, rounds?: number },
 *   player: string,
 * }
 * @returns Array<candidate> ready for createExperienceStore().remember()
 */
export function distillMatch(facts = {}) {
  const player = String(facts.player ?? '');
  const game = String(facts.game ?? 'lol');
  const champion = String(facts.champion ?? '');
  const patch = has(facts.patch) ? String(facts.patch) : null;
  const outcome = ['win', 'loss'].includes(facts.outcome) ? facts.outcome : 'unknown';
  const candidates = [];
  const scope = [`game:${game}`, ...(champion ? [`champ:${champion}`] : [])];

  // 1) Champion record: the claim text is constant on purpose, so repeated matches merge into one
  // line whose evidence counts wins as hits. This is how "记得这个英雄我打得怎么样" accrues.
  if (player && champion) {
    candidates.push({
      kind: 'stats',
      private: true,
      player,
      claim: `${champion} 战绩记录`,
      scope,
      patch,
      evidence: { games: 1, hits: outcome === 'win' ? 1 : 0 },
    });
  }

  // 2) A death reminder that is followed by another death within the window is evidence the
  // reminder's timing or wording does not land; that is a private pitfall, not global knowledge.
  const reminders = Array.isArray(facts.deathReminders) ? facts.deathReminders : [];
  const ignored = reminders.filter((row) => row?.ignoredAfterReminder === true).length;
  if (player && ignored >= 2) {
    candidates.push({
      kind: 'pitfall',
      private: true,
      player,
      claim: `${champion || '本命英雄'} 收到阵亡提醒后仍连续阵亡，提醒需要更早给出`,
      scope: [...scope, 'event:death'],
      patch,
      evidence: { games: Math.max(1, reminders.length), hits: Math.max(0, reminders.length - ignored) },
    });
  }

  // 3) Blind augment recognition is a tooling fact, so it is worth sharing with every player.
  const blind = Number(facts.recognition?.blindFrames) || 0;
  if (blind >= 8) {
    candidates.push({
      kind: 'recognition',
      claim: '卡面连续多帧读不出名字时，先取前后两帧比对再交给视觉模型，不要单帧判定',
      scope: ['game:lol', 'event:augment'],
      patch: null,
      evidence: { games: 1, hits: 1 },
    });
  }

  return candidates
    .filter((candidate) => candidate.kind && candidate.claim)
    .filter((candidate) => !PUBLIC_KINDS.has(candidate.kind) || !candidate.private)
    .slice(0, MAX_LESSONS);
}
