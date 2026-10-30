import { createMobileTeamSession } from './mobile-session.mjs';

const native = globalThis.JinbaoTeamNative;
const requests = new Map();
globalThis.jinbaoTeamReceive = (id, status, body) => {
  const job = requests.get(id);
  if (!job) return;
  requests.delete(id); clearTimeout(job.timeout);
  job.resolve(new Response(body, { status, headers: { 'Content-Type': 'application/json' } }));
};
const transport = (path, method, body) => new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => { requests.delete(id); reject(new Error('队伍连接超时，请稍后重试。')); }, 16_000);
    requests.set(id, { resolve, reject, timeout });
    native.request(id, path, method, body ?? '');
  });
const collection = typeof native.hasCollection === 'function' && native.hasCollection() ? {
  async api(action, data) {
    const response = await transport('/desktop/team-local/collection', 'POST', JSON.stringify({ action, ...data }));
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error), { code: result.error, status: response.status });
    return result;
  },
} : null;
const session = createMobileTeamSession({ accountKey: native.accountKey(), storage: localStorage, collection,
  fetchImpl: (url, options) => transport(new URL(url).pathname + new URL(url).search, options.method, options.body) });
export async function nativeApi(action, data) {
  try { return await session.api(action, data); }
  catch (error) {
    const messages = { login_required: '请先在金宝 App 登录微信，再打开队伍。',
      connection_expired: '连接码无效或已过期，请在原设备重新生成。', connection_claimed: '连接码已被申请，请重新生成。',
      already_room_member: '此账号已经是队伍成员，请先处理重复成员。', original_login_required: '请在最初加入队伍的登录端操作。',
      room_full: '队伍已满，最多 5 人。', invite_unavailable: '邀请码无效或已过期。', owner_required: '此操作需要群主在原登录端完成。',
      team_unavailable: '群聊服务暂未开放或暂不可用，请稍后重试。', room_privacy_cleanup_pending: '队伍正在处理数据，金宝暂不能回答，请稍后重试。', rate_limited: '操作较频繁，请稍后重试。',
      fresh_match_required: '请先启动手机游戏采集，等待识别到本局。', match_binding_unavailable: '队伍尚未开启王者对局，或游戏不一致。',
      collection_match_changed: '手机对局已变化，请重新核对本局。', collection_room_changed: '当前队伍已变化，请重新打开。',
      collection_busy: '手机信息正在同步，请稍后重试。' };
    Object.assign(messages, { memory_cursor_changed: '记忆已更新，请重新检索。', memory_pending_limit: '你的待确认记忆已达50条，请先确认或删除已有提议。' });
    Object.assign(messages, { original_owner_required: '请在群主原登录端操作。', room_recovery_expired: '恢复期限已过或正在清理，无法恢复。', memory_outdated: '这是解散前大厅的临时记忆，只能删除。' });
    Object.assign(messages, { host_offline: '电脑主机尚未连接，请先在电脑完成授权并保持金宝运行。',
      host_proposal_unavailable: '主机申请已过期或变化，请在电脑重新申请。', host_change_busy: '队伍还有任务未结束，请稍后再操作。',
      execution_change_busy: '还有任务或待核对费用，暂不能切换执行方式。', host_reconciliation_required: '主机还有待核对费用，暂不能更换。' });
    messages.room_creation_limit = '队伍成员的当前或可恢复房间数量已达上限，请先处理现有队伍。';
    Object.assign(messages, { confirmation_expired: '确认已过期、已由另一端处理或本轮选项已变化。',
      confirmation_unavailable: '这条确认不属于当前成员或已不可用。', invalid_confirmation_choice: '确认选项或倒计时状态已变化，请刷新核对。' });
    throw new Error(messages[error.code] ?? (error.code ? '队伍操作未完成，请检查输入或稍后重试。' : error.message));
  }
}
