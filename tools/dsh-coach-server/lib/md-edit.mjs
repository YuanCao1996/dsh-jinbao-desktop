// 经验 md 是“可编辑的镜像”：玩家改自己的私有 md、agent 修订过期条目，都要能回到 index 生效。
//
// 这里只做纯文本层面的解析与 diff，不碰存储——存储层（experience-store）负责把 diff 落成
// add / retire 操作，于是“改一个字”不会把一条被验证过 20 次的经验清零。

const LINE = /^\s*-\s*\[([^\]|]*)\|([^\]|]*)\|([^\]]*)\]\s*(.+?)\s*$/;

export function parseMd(text) {
  const entries = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const match = LINE.exec(raw);
    if (!match) continue;
    const games = Number(String(match[2]).replace(/[^0-9.]/g, ''));
    entries.push({
      confidence: Number(match[1]) || null,
      games: Number.isFinite(games) ? games : null,
      status: String(match[3]).trim() || 'candidate',
      claim: String(match[4]).trim(),
    });
  }
  return entries;
}

const normalize = (claim) => String(claim ?? '').replace(/\s+/g, '').toLowerCase();

/**
 * 把“编辑后的 md”与“编辑前的 index”对齐。
 * - 新增行 → 作为新经验写入（证据从 1 局起算，不凭空继承别人的置信度）
 * - 删除/改写的行 → 对应旧经验退役（保留历史，不物理删除）
 * - 未改动的行 → 原样保留，证据不受影响
 */
export function diffMd({ mdText, records = [] }) {
  const shown = parseMd(mdText);
  const shownKeys = new Set(shown.map((entry) => normalize(entry.claim)));
  const kept = [];
  const retired = [];
  for (const record of records) {
    if (shownKeys.has(normalize(record.claim))) kept.push(record);
    else retired.push(record);
  }
  const known = new Set(records.map((record) => normalize(record.claim)));
  const added = shown.filter((entry) => !known.has(normalize(entry.claim)));
  return { kept, retired, added };
}

/** 人类/agent 都可用的单条修订描述（用于记录来源，便于回溯“谁改的、为什么”）。 */
export function editNote({ by = 'player', reason = '' } = {}) {
  const who = by === 'agent' ? 'agent' : 'player';
  return `edited-by:${who}${reason ? ' | ' + String(reason).slice(0, 120) : ''}`;
}
