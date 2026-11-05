// 把“学习动作”翻译成玩家能看懂的一句话，用于悬浮窗的智能体动态。
//
// 目的不是日志，而是让玩家感知到系统在学、并且学了什么：所以每条都要带结论本身和证据量，
// 而不是「已更新经验库」这种没有信息量的字句。

const VERB = {
  add: '记下一条经验',
  update: '补充验证',
  dispute: '收到反驳，降级',
  retire: '退役过时经验',
  correct: '按你的判断退役',
  edit: '修订经验',
};

const clip = (text, max = 60) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
};

export function formatLearningNotice(event = {}) {
  const verb = VERB[event.action] ?? '更新经验';
  const claim = clip(event.claim);
  if (!claim) return '';
  const bits = [verb + '：' + claim];
  const games = Number(event.evidence?.games);
  const hits = Number(event.evidence?.hits);
  if (event.action === 'add') {
    bits.push(games > 1 ? '来自 ' + games + ' 局' : '首局观察');
  } else if (event.action === 'update') {
    if (Number.isFinite(games) && Number.isFinite(hits) && games > 0) bits.push('已验证 ' + hits + '/' + games + ' 局');
  } else if (event.action === 'dispute' || event.action === 'correct') {
    bits.push('不再注入');
  }
  if (event.by === 'agent') bits.push('教练自行判断');
  if (event.by === 'player') bits.push('你做的调整');
  if (event.reason) bits.push('理由：' + clip(event.reason, 30));
  return bits.join(' · ');
}

// 活动流的行结构：与 agent-activity 面板一致（kind + text + 时间）。
export function toActivityRow(event = {}, now = Date.now()) {
  const text = formatLearningNotice(event);
  if (!text) return null;
  return { kind: 'learn', text, at: Number(event.at) || now };
}
