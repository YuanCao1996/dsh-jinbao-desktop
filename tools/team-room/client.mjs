const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
export const unchangedSentDraft = (sent, current) => ['revision', 'roomId', 'text', 'ask', 'replyTo'].every(key => sent[key] === current[key]);
export function teamAccessLoss(error) {
  if (error?.status === 401 || error?.status === 403
    && ['email_login_refresh_required', 'verified_login_required', 'identity_mismatch', 'account_deletion_pending'].includes(error.code)) return 'authentication';
  if ([403, 404].includes(error?.status)
    && ['room_forbidden', 'room_unavailable', 'membership_removed'].includes(error.code)) return 'membership';
  return null;
}
export const adviceStatusLabel = message => message.role !== 'assistant' ? '' : message.adviceStatus === 'context_changed'
  ? '生成这条建议时的对局信息已变化或过期，请以最新状态为准。'
  : message.adviceStatus === 'previous_match' ? '这是旧对局的建议，仅作历史参考。' : '';
export function updateAdviceStatuses(messages,updates,room){
  const valid=new Map((Array.isArray(updates)?updates:[]).slice(0,100).filter(row=>Number.isSafeInteger(row?.seq)&&row.seq>0&&['current','context_changed','previous_match'].includes(row.adviceStatus)).map(row=>[row.seq,row.adviceStatus]));
  return messages.map(message=>{
    if(message.role!=='assistant')return message;
    const status=valid.get(message.seq)??(message.adviceStatus&&message.roomMatchId!==(room.currentMatch?.id??null)?'previous_match':message.adviceStatus);
    return status?{...message,adviceStatus:status}:message;
  });
}
export const roomMentorName = room => room?.mentorRoles?.find(role => role.id === room.mentorRole)?.name || '金宝';
// Shared copy for the browser, phone WebView and desktop overlay. Never render
// raw task errors/provider text, and do not leave an old failure on screen forever.
export function roomTaskStatus(state, now = Date.now()) {
  const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
  if (tasks.some(task => task?.status === 'running')) return roomMentorName(state.room) + '正在处理队伍问题…';
  if (tasks.some(task => task?.status === 'queued')) return '队伍问题排队中；普通聊天可继续。';
  const latest = tasks.filter(task => task && Number.isSafeInteger(task.createdAt) && task.createdAt <= now + 5000)
    .reduce((last, task) => !last || task.createdAt >= last.createdAt ? task : last, null);
  const held = Number.isSafeInteger(state?.budget?.pendingReconciliations) && state.budget.pendingReconciliations > 0;
  if (latest && now - latest.createdAt <= 300000) {
    const label = latest.automatic ? '这条主动建议' : '本次提问';
    if (latest.status === 'cancelled') return label + '涉及的信息已变化或过期，旧回答未发布；需要时请重新提问。';
    if (latest.status === 'failed') {
      if (latest.error === 'reconciled_without_reply') return label + '的用量已核对，未补发旧回答；需要时请重新提问。';
      if (held || ['usage_reconciliation_pending', 'worker_interrupted_usage_pending', 'settlement_reconciliation_pending', 'room_dissolved_usage_pending'].includes(latest.error)) {
        return label + '未完成，用量待核对，不会自动重试模型；普通聊天可继续。';
      }
      return label + '未完成，未生成有效回答；可稍后重新提问。';
    }
  }
  return held ? '有任务的用量待核对；普通聊天可继续，请勿连续重复提问。' : '';
}
export function roomProgressStatus(state, now = Date.now()) {
  if (state?.error) return state.error;
  const task = roomTaskStatus(state, now), notice = state?.notice || '';
  return task && notice && task !== notice ? task + '\n' + notice : task || notice;
}
export function mentionsRoomMentor(text, room) {
  return typeof text === 'string' && ['金宝', roomMentorName(room)].some(name => text.includes('@' + name) || text.includes('＠' + name));
}
export class TeamClientError extends Error {
  constructor(code, status = 503) { super(code); this.code = code; this.status = status; }
}
function hostMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TeamClientError('invalid_response');
  const amount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return { configured: value.configured === true, online: value.online === true, canApprove: value.canApprove === true,
    executionAvailable: value.executionAvailable === true,
    state: ['not_configured', 'authorization_required', 'connected', 'offline'].includes(value.state) ? value.state : 'not_configured',
    memberId: validId(value.memberId) ? value.memberId : null, deviceName: typeof value.deviceName === 'string' ? value.deviceName.slice(0, 40) : null,
    maxTokens: amount(value.maxTokens), spent: amount(value.spent) ?? 0, reserved: amount(value.reserved) ?? 0,
    proposals: (Array.isArray(value.proposals) ? value.proposals : []).slice(0, 5)
      .filter(proposal => proposal && validId(proposal.id) && typeof proposal.deviceName === 'string' && amount(proposal.maxTokens) !== null && amount(proposal.expiresAt) !== null)
      .map(proposal => ({ id: proposal.id, deviceName: proposal.deviceName.slice(0, 40), maxTokens: proposal.maxTokens, expiresAt: proposal.expiresAt })) };
}
export function createTeamClient({ serviceBaseUrl, getToken, fetchImpl = fetch }) {
  const base = new URL(serviceBaseUrl);
  let adviceScan = { roomId: null, after: 0 };
  let advicePaging = true;
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/'
    || base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) throw new Error('invalid_team_service');
  const roomPath = roomId => {
    if (!validId(roomId)) throw new TeamClientError('invalid_room', 400);
    return `/rooms/${roomId}`;
  };
  async function request(path, method = 'GET', data, signal) {
    const token = await getToken();
    if (typeof token !== 'string' || !token || /\s/.test(token)) throw new TeamClientError('login_required', 401);
    const response = await fetchImpl(new URL(`/desktop/team${path}`, base), {
      method, headers: { Authorization: `Bearer ${token}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }), redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
    let bytes = 0; const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 128_000) { await response.body?.cancel().catch(() => {}); throw new TeamClientError('response_too_large'); }
      chunks.push(chunk);
    }
    const merged = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
    let value;
    try { value = JSON.parse(new TextDecoder().decode(merged)); } catch { throw new TeamClientError('invalid_response'); }
    if (!response.ok) throw new TeamClientError(typeof value.error === 'string' ? value.error : 'team_unavailable', response.status);
    return value;
  }
  return {
    list: () => request('/rooms'),
    closedRooms: (after = 0, limit = 20) => request(`/closed-rooms?after=${after}&limit=${limit}`),
    dissolve: roomId => request(roomPath(roomId) + '/dissolve', 'POST', {}),
    restore: roomId => request(roomPath(roomId) + '/restore', 'POST', {}),
    create: (name, displayName) => request('/rooms', 'POST', { name, displayName }),
    join: (code, displayName) => request('/join', 'POST', { code, displayName }),
    claimConnection: (code, deviceName) => request('/connect', 'POST', { code, deviceName }),
    connectionCode: roomId => request(roomPath(roomId) + '/connection-code', 'POST', {}),
    connections: roomId => request(roomPath(roomId) + '/connections'),
    updateConnection: (roomId, action, connectionId) => request(roomPath(roomId) + '/connection-update', 'POST', { action, connectionId }),
    cancelConnection: (roomId, requestId) => request(roomPath(roomId) + '/connection-cancel', 'POST', { requestId }),
    get: roomId => request(roomPath(roomId)),
    dashboard: async (roomId, after = null, cachedMessages = null, knownPrivacyVersion = null) => {
      const params = new URLSearchParams();
      if (after !== null) params.set('after', String(after));
      const seqs = (Array.isArray(cachedMessages) ? cachedMessages : []).slice(-500)
        .map(row => row?.seq).filter(seq => Number.isSafeInteger(seq) && seq > 0);
      let first, last, scanAfter;
      if (seqs.length && advicePaging) {
        first = Math.min(...seqs) - 1; last = Math.max(...seqs);
        scanAfter = adviceScan.roomId === roomId && adviceScan.after >= first && adviceScan.after < last ? adviceScan.after : first;
        params.set('adviceAfter', String(scanAfter));
      } else adviceScan = { roomId, after: 0 };
      const path = () => roomPath(roomId) + '/dashboard' + (params.size ? '?' + params : '');
      let page;
      try { page = await request(path()); }
      catch (error) {
        if (scanAfter === undefined || error.status !== 400 || error.code !== 'invalid_query') throw error;
        // An older gateway rejects the new query field. Fall back once to its
        // recent-message protocol until this client is recreated after update.
        advicePaging = false; params.delete('adviceAfter'); page = await request(path());
      }
      const privacyVersion = page.room?.privacyVersion ?? 0;
      if (knownPrivacyVersion !== null && privacyVersion !== knownPrivacyVersion) {
        const stale = () => Object.assign(new TeamClientError('privacy_refresh_required'), { privacyVersion: Math.max(privacyVersion, knownPrivacyVersion) });
        if (privacyVersion < knownPrivacyVersion) throw stale();
        try { page = await request(roomPath(roomId) + '/dashboard'); }
        catch { throw stale(); }
        if ((page.room?.privacyVersion ?? 0) < privacyVersion) throw stale();
        page.resetMessages = true; adviceScan = { roomId, after: 0 };
      }
      if (seqs.length && advicePaging && !page.resetMessages) {
        const cursor = page.adviceCursor;
        adviceScan = { roomId, after: page.adviceHasMore === true && Number.isSafeInteger(cursor)
          && cursor > scanAfter && cursor < last ? cursor : first };
      }
      return page;
    },
    confirmations: roomId => request(roomPath(roomId) + '/confirmations'),
    respondConfirmation: (roomId, data) => request(roomPath(roomId) + '/confirmation-response', 'POST', data),
    invite: roomId => request(roomPath(roomId) + '/invite', 'POST', {}),
    leave: roomId => request(roomPath(roomId) + '/leave', 'POST', {}),
    remove: (roomId, memberId) => request(roomPath(roomId) + '/remove', 'POST', { memberId }),
    transfer: (roomId, memberId) => request(roomPath(roomId) + '/transfer', 'POST', { memberId }),
    setAutomaticAdvice: (roomId, automaticAdvice) => request(roomPath(roomId) + '/settings', 'POST', { automaticAdvice }),
    setPostGameRecap: (roomId, postGameRecap) => request(roomPath(roomId) + '/settings', 'POST', { postGameRecap }),
    setMentorRole: (roomId, mentorRole) => request(roomPath(roomId) + '/settings', 'POST', { mentorRole }),
    setExecutionMode: (roomId, executionMode) => request(roomPath(roomId) + '/settings', 'POST', { executionMode }),
    hostStatus: async roomId => hostMetadata(await request(roomPath(roomId) + '/host')),
    proposeHost: (roomId, input) => request(roomPath(roomId) + '/host-proposal', 'POST', input),
    approveHost: (roomId, proposalId) => request(roomPath(roomId) + '/host-approve', 'POST', { proposalId }),
    revokeHost: roomId => request(roomPath(roomId) + '/host-revoke', 'POST', {}),
    withdrawHost: roomId => request(roomPath(roomId) + '/host-withdraw', 'POST', {}),
    acquireHost: (roomId, proof, signal) => request(roomPath(roomId) + '/host-acquire', 'POST', proof, signal),
    heartbeatHost: (roomId, proof, signal) => request(roomPath(roomId) + '/host-heartbeat', 'POST', proof, signal),
    pollHost: (roomId, proof, signal) => request(roomPath(roomId) + '/host-poll', 'POST', proof, signal),
    checkHost: (roomId, proof, jobId, signal) => request(roomPath(roomId) + '/host-check', 'POST', { ...proof, jobId }, signal),
    executeHostTool: (roomId, proof, input, signal) => request(roomPath(roomId) + '/host-tool', 'POST', { ...proof, ...input }, signal),
    recordHostUsage: (roomId, proof, input, signal) => request(roomPath(roomId) + '/host-usage', 'POST', { ...proof, ...input }, signal),
    completeHost: (roomId, proof, input, signal) => request(roomPath(roomId) + '/host-complete', 'POST', { ...proof, ...input }, signal),
    failHost: (roomId, proof, jobId, signal) => request(roomPath(roomId) + '/host-fail', 'POST', { ...proof, jobId }, signal),
    messages: (roomId, after = 0, limit = 30) => request(`${roomPath(roomId)}/messages?after=${after}&limit=${limit}`),
    send: (roomId, { clientMessageId, text, replyTo = null, ask = false }) => request(roomPath(roomId) + '/messages', 'POST', { clientMessageId, text, replyTo, trigger: ask ? 'ask' : 'none' }),
    enqueue: (roomId, messageSeq) => request(roomPath(roomId) + '/tasks', 'POST', { messageSeq }),
    tasks: roomId => request(roomPath(roomId) + '/tasks'),
    budget: roomId => request(roomPath(roomId) + '/budget'),
    authorizeBudget: (roomId, maxTokens) => request(roomPath(roomId) + '/budget', 'POST', { maxTokens }),
    startMatch: (roomId, matchKey, game, mode) => request(roomPath(roomId) + '/match', 'POST', { matchKey, game, mode }),
    publish: (roomId, observation) => request(roomPath(roomId) + '/observations', 'POST', observation),
    currentState: roomId => request(roomPath(roomId) + '/state'),
    memberState: (roomId, memberId) => request(`${roomPath(roomId)}/member-state?memberId=${encodeURIComponent(memberId)}`),
    memories: (roomId, query = '', pending = false, options = {}) => {
      const params = new URLSearchParams({ query, pending: String(pending) });
      for (const key of ['cursor', 'memoryVersion', 'type', 'limit']) if (options[key] !== undefined && options[key] !== null) params.set(key, String(options[key]));
      return request(`${roomPath(roomId)}/memories?${params}`);
    },
    proposeMemory: (roomId, input) => request(roomPath(roomId) + '/memories', 'POST', input),
    updateMemory: (roomId, memoryId, action, content) => request(roomPath(roomId) + '/memory-update', 'POST', { memoryId, action, ...(content === undefined ? {} : { content }) }),
  };
}
