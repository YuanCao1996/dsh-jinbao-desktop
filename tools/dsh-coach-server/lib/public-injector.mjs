// 服务端注入：经验原文永不下发。
//
// 客户端只把"当前局面"的标签发上来（游戏/英雄/强化/阵容/阶段/版本），服务端在这里把匹配到的
// 公有经验拼成一段提示词交给模型，客户端只收到最终建议。这样即便有人抓包或做镜像，也拿不到经验库
// 本身——从根上防住拖库。
//
// 这个模块是纯函数：不碰网络、不碰存储，所以规则可以被确定性地测。

const HEADER = '【社区经验｜仅作参考，不覆盖本局事实】';
const SCOPE_WEIGHT = { champ: 4, aug: 4, comp: 3, game: 2, event: 2, phase: 1, intent: 1 };

/** 从客户端上报的局面生成检索标签；只接受白名单键，避免被塞进任意内容。 */
export function contextTags(context = {}) {
  const tags = [];
  const game = String(context.game ?? '').trim();
  if (game) tags.push('game:' + game);
  const champion = String(context.champion ?? '').trim();
  if (champion) tags.push('champ:' + champion);
  for (const augment of (Array.isArray(context.augments) ? context.augments : []).slice(0, 3)) {
    const name = String(augment ?? '').trim();
    if (name) tags.push('aug:' + name);
  }
  for (const comp of (Array.isArray(context.comps) ? context.comps : []).slice(0, 3)) {
    const name = String(comp ?? '').trim();
    if (name) tags.push('comp:' + name);
  }
  const phase = String(context.phase ?? '').trim().toLowerCase();
  if (phase) tags.push('phase:' + phase);
  if (context.dead === true) tags.push('event:death');
  return [...new Set(tags)].slice(0, 12);
}

function confidenceOf(lesson) {
  const games = Number(lesson.evidence?.games) || 0;
  const hits = Number(lesson.evidence?.hits) || 0;
  const counter = Number(lesson.evidence?.counter) || 0;
  return Math.min(0.99, Math.max(0.05, (hits + 1) / (games + 2) - 0.15 * counter));
}

function scoreOf(lesson, wanted) {
  let relevance = 0;
  for (const tag of lesson.scope ?? []) {
    const kind = String(tag).split(':')[0];
    if (wanted.has(tag)) relevance += SCOPE_WEIGHT[kind] ?? 1;
  }
  return relevance * 2 + confidenceOf(lesson) * 3 + Math.log1p(Number(lesson.evidence?.games) || 0);
}

/**
 * 把候选经验拼成注入块。
 * @param lessons 已从库中查出的候选（服务端内部数据，绝不下发）
 * @param context 客户端上报的局面标签来源
 * @returns {{section: string, used: string[], dropped: number}}
 */
export function buildInjection({ lessons = [], context = {}, patch = null, budgetChars = 400, maxItems = 6 } = {}) {
  const wanted = new Set(contextTags(context));
  // 具体标签（英雄/强化/阵容）必须命中其一：同游戏不同英雄的经验不该进提示词，
  // 否则英雄专精的经验会污染所有对局。只带 game 标签的通用教训（识别/工具类）仍然可用。
  const specific = (lesson) => (lesson.scope ?? []).some((tag) => /^(champ|aug|comp):/.test(String(tag)));
  const ranked = (Array.isArray(lessons) ? lessons : [])
    .filter((lesson) => lesson && lesson.claim)
    // 只有被至少 3 个独立账号验证过的经验才能进提示词；待验证池不对外。
    .filter((lesson) => (lesson.status ?? 'public') === 'public')
    .filter((lesson) => !specific(lesson) || (lesson.scope ?? []).some((tag) => /^(champ|aug|comp):/.test(String(tag)) && wanted.has(String(tag))))
    // 版本不符的旧经验不进提示词；没有版本标注的保留（判不出年代的别静默丢）
    .filter((lesson) => !lesson.patch || !patch || lesson.patch === patch)
    .map((lesson) => ({ lesson, score: scoreOf(lesson, wanted) }))
    .filter((entry) => entry.score > 0.7)
    .sort((left, right) => right.score - left.score);

  const lines = [];
  const used = [];
  let dropped = 0;
  let size = HEADER.length + 1;
  for (const { lesson } of ranked) {
    if (lines.length >= maxItems) { dropped += 1; continue; }
    // 只放结论与置信度，不放 fingerprint/scope/evidence 细节——服务端内部字段没有必要进模型上下文。
    const line = `- [${confidenceOf(lesson).toFixed(2)}] ${String(lesson.claim).slice(0, 120)}`;
    if (size + line.length + 1 > budgetChars) { dropped += 1; continue; }
    lines.push(line);
    used.push(lesson.fingerprint ?? null);
    size += line.length + 1;
  }
  return {
    section: lines.length ? [HEADER, ...lines].join('\n') : '',
    used: used.filter(Boolean),
    dropped,
  };
}
