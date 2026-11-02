// Visual tie-break for the augment panel.
//
// The 20 Hz card watcher decides most picks locally. When it cannot (the panel faded
// before a clean sample, or all three cards moved together) the two saved frames go to a
// vision model and its answer is mapped back to a card slot here.
//
// This module is deliberately pure: prompt text and answer parsing are testable without a
// model, which matters because the pick decides which augment the whole match assumes.

export const TIEBREAK_QUESTION = [
  '这是同一场对局中同一位置的强化卡片面板，前后两张图。',
  '三张卡片里只有被玩家选择（或鼠标悬停）的那一张会发生变化，其余两张保持完全静止。',
  '请只判断哪一张发生了变化，用一行回答：',
  '1 = 第一张，2 = 第二张，3 = 第三张，看不清就回答 0。',
  '不要解释，不要复述图片内容。',
].join('\n');

export const TIEBREAK_SYSTEM = '你是图像比对工具，只输出一个数字，不输出其他任何内容。';

// Map a model answer to a slot. Returns null for 0/unsure/unparseable, never guesses.
export function parseTiebreakAnswer(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  // Accept "2", "第2张", "2." etc. A leading digit is the documented contract.
  const match = text.match(/[0-3]/);
  if (!match) return null;
  const slot = Number(match[0]);
  // 0 means "cannot tell" by the prompt contract; 1-3 are slots.
  if (slot < 1 || slot > 3) return null;
  // Refuse ambiguous answers that list more than one candidate number.
  const digits = new Set(text.match(/[1-3]/g) ?? []);
  if (digits.size > 1) return null;
  return slot - 1;
}

// The pick a tie-break answer implies, or null when it must stay a question for the player.
export function tiebreakPick({ answer, options, roll } = {}) {
  const slot = parseTiebreakAnswer(answer);
  if (slot === null) return null;
  const list = Array.isArray(options) ? options : [];
  const option = list.find((row) => Number(row?.slot) === slot) ?? list[slot];
  const name = typeof option === 'string' ? option : option?.name;
  if (typeof name !== 'string' || !name) return null;
  return {
    kind: 'augment_picked',
    who: 'self',
    name,
    augment: name,
    roll: roll ?? null,
    // A model tie-break is a real observation, but it is weaker than the pixel watcher,
    // so the dialog still stays available as a correction path.
    source: 'vision-model',
    confidence: 'high',
  };
}
