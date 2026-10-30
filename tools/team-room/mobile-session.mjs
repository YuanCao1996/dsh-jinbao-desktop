import { createTeamClient, mentionsRoomMentor, updateAdviceStatuses, teamAccessLoss } from './client.mjs';

// Browser/native controller. The native transport injects login credentials;
// neither this controller nor localStorage receives the App session token.
export function createMobileTeamSession({ fetchImpl, storage, accountKey, now = Date.now, collection = null }) {
  const key = `jinbao-team:${accountKey}`;
  let saved;
  try { saved = JSON.parse(storage.getItem(key) ?? '{}'); } catch { saved = {}; }
  let roomId = typeof saved.roomId === 'string' ? saved.roomId : null, pending = saved.pending ?? null;
  let sharingPaused = saved.sharingPaused === true;
  const deviceId = /^[a-f0-9-]{36}$/.test(saved.deviceId ?? '') ? saved.deviceId : crypto.randomUUID();
  let state = { supported: true, mode: 'team', room: null, messages: [], tasks: [], memories: [], connections: null,
    budget: null, connected: false, sharing: 'not_shared', shareGameInfo: false, notice: null, error: null };
  const client = createTeamClient({ serviceBaseUrl: 'https://api.jinbaoai.top', getToken: () => 'native-transport', fetchImpl });
  const persist = () => storage.setItem(key, JSON.stringify({ roomId, pending, deviceId, sharingPaused }));
  persist();
  const view = () => structuredClone({ ...state, connectionPending: !!pending });
  async function loseAccess(error) {
    const lost = teamAccessLoss(error);
    if (!lost) return;
    const previousRoom = roomId;
    sharingPaused = true;
    if (lost === 'membership') roomId = null;
    pending = null; state = { ...state, connected: false, room: null, messages: [], tasks: [], memories: [], confirmations: [],
      budget: null, connections: null, host: null, shareGameInfo: false, sharing: 'not_shared',
      error: lost === 'authentication' ? '登录已失效，请先在金宝 App 重新登录。' : '队伍访问已结束。' };
    persist();
    if (collection) { try { await collection.api('sharing', { roomId: previousRoom, enabled: false }); } catch {} }
  }
  async function refresh() {
    if (pending) {
      if (pending.expiresAt <= now()) { pending = null; state.notice = '连接申请已过期，请重新发起。'; persist(); }
      else {
        try { await client.get(pending.roomId); roomId = pending.roomId; pending = null; persist(); state.notice = '已连接，两端共用一个队伍成员。'; }
        catch (error) { if (error.code === 'room_forbidden') { state.notice = '等待原设备确认连接…'; return view(); } throw error; }
      }
    }
    if (!roomId) return view();
    try {
      const dashboard = await client.dashboard(roomId, state.room?.id === roomId ? state.messages.at(-1)?.seq ?? 0 : null,
        state.room?.id === roomId ? state.messages : null,
        state.room?.id === roomId ? state.room.privacyVersion ?? 0 : null), room = dashboard.room;
      const messages = state.room?.id === room.id && !dashboard.resetMessages ? [...state.messages] : [];
      let pageResult = dashboard.messages, cursor;
      for (let n = 0; n < 10; n++) {
        const page = pageResult ?? await client.messages(roomId, cursor, 30); pageResult = null;
        messages.push(...page.items); cursor = page.cursor;
        if (!page.hasMore) break;
      }
      const { tasks, budget, memories, connections, confirmations } = dashboard;
      let host = null;
      if (room.executionHost?.executionAvailable) { try { host = await client.hostStatus(roomId); } catch (error) { if (teamAccessLoss(error)) throw error; } }
      state = { ...state, room, messages: updateAdviceStatuses(messages.slice(-500),dashboard.adviceUpdates,room), tasks: tasks.items, budget, memories: memories.items, connections, host, confirmations: confirmations.items, connected: true, error: null };
      if (collection) {
        state.collectionSupported = true;
        try {
          if (sharingPaused) await collection.api('sharing', { roomId, enabled: false });
          const info = await collection.api('select', { roomId });
          state.collectionAvailable = info.available === true;
          state.shareGameInfo = !sharingPaused && info.enabled === true; state.sharing = sharingPaused ? 'not_shared' : info.state;
        } catch { state.collectionAvailable = false; state.shareGameInfo = false; state.sharing = 'team_unavailable'; }
      }
    } catch (error) {
      state.connected = false;
      if (error.code === 'privacy_refresh_required') state = { ...state, messages: [], memories: [], room: state.room ? { ...state.room, privacyVersion: error.privacyVersion } : null };
      const lost = teamAccessLoss(error);
      state.error = lost === 'authentication' ? '登录已失效，请先在金宝 App 重新登录。' : '队伍连接暂不可用，请稍后重试。';
      if (lost) await loseAccess(error);
    }
    return view();
  }
  async function command(action, data = {}) {
    if (pending && ['create', 'join', 'open', 'restore', 'connect'].includes(action)) {
      await client.cancelConnection(pending.roomId, pending.requestId); pending = null; persist();
    }
    let room;
    switch (action) {
      case 'list': return client.list();
      case 'closed-list': return client.closedRooms(data.after ?? 0, data.limit ?? 20);
      case 'restore':
        if (collection && roomId) await collection.api('sharing', { roomId, enabled: false });
        room = await client.restore(data.roomId); break;
      case 'create': room = await client.create(data.name, data.displayName); break;
      case 'join': room = await client.join(data.code, data.displayName); break;
      case 'open': room = await client.get(data.roomId); break;
      case 'connect': pending = await client.claimConnection(data.code, data.deviceName); persist(); state.notice = '等待原设备确认连接…'; return pending;
      case 'cancel-connection':
        if (pending) await client.cancelConnection(pending.roomId, pending.requestId);
        pending = null; state.notice = null; persist(); return { cancelled: true };
      case 'connection-code': return client.connectionCode(roomId);
      case 'connection-update': return client.updateConnection(roomId, data.action, data.connectionId);
      case 'history': return client.messages(roomId, data.after ?? 0, data.limit ?? 50);
      case 'memory-query': return client.memories(roomId, data.query ?? '', true, data);
      case 'invite': return client.invite(roomId);
      case 'leave': case 'dissolve':
        if (collection) await collection.api('sharing', { roomId, enabled: false });
        if (action === 'dissolve') await client.dissolve(roomId); else await client.leave(roomId);
        roomId = null; pending = null;
        state = { ...state, room: null, messages: [], tasks: [], memories: [], confirmations: [], budget: null, connections: null,
          connected: false, shareGameInfo: false, sharing: 'not_shared' }; persist(); return { left: true };
      case 'send': {
        const result = await client.send(roomId, { ...data, ask: data.ask === true || mentionsRoomMentor(data.text, state.room) });
        if (result.message.trigger === 'ask') {
          try { await client.enqueue(roomId, result.message.seq); }
          catch (error) { if (teamAccessLoss(error)) throw error; return { ...result, admission: { accepted: false, message: error.code === 'room_budget_required' ? '群主尚未授权队伍预算，消息已发出。' : error.code === 'room_privacy_cleanup_pending' ? '消息已发出，队伍正在处理数据，金宝暂不能回答，请稍后重试。' : '消息已发出，但本次提问未受理，可稍后重试。' } }; }
        }
        return result;
      }
      case 'ask-existing': return client.enqueue(roomId, data.messageSeq);
      case 'budget': return client.authorizeBudget(roomId, data.maxTokens);
      case 'automatic': return client.setAutomaticAdvice(roomId, data.enabled);
      case 'recap': return client.setPostGameRecap(roomId, data.enabled);
      case 'role': return client.setMentorRole(roomId, data.role);
      case 'host-approve': return client.approveHost(roomId, data.proposalId);
      case 'host-revoke': return client.revokeHost(roomId);
      case 'execution-mode': return client.setExecutionMode(roomId, data.mode);
      case 'confirmation': return client.respondConfirmation(roomId, { ...data, deviceId });
      case 'remove': return client.remove(roomId, data.memberId);
      case 'transfer': return client.transfer(roomId, data.memberId);
      case 'memory-propose': return client.proposeMemory(roomId, data);
      case 'memory-update': return client.updateMemory(roomId, data.memoryId, data.action, data.content);
      case 'mode': state.mode = data.mode === 'personal' ? 'personal' : 'team'; return view();
      case 'sharing': case 'bind-match': case 'start-match':
        if (!collection) throw new Error('此版本尚不支持手机整理信息共享。');
        if (!state.connected || !state.room) throw new Error('请先恢复登录和队伍连接。');
        await collection.api(action, { roomId, ...(action === 'sharing' ? { enabled: data.enabled === true } : {}) });
        sharingPaused = action === 'sharing' && data.enabled !== true; persist();
        return refresh();
      default: throw new Error('此操作需要在正在采集游戏的电脑端执行。');
    }
    roomId = room.id; pending = null;
    state = { ...state, room: null, messages: [], tasks: [], memories: [], budget: null, connections: null, notice: null };
    persist(); return refresh();
  }
  let queue = Promise.resolve();
  return { view,
    async api(action, data) {
      const result = queue.then(async () => {
        try { return await (action ? command(action, data) : refresh()); }
        catch (error) { await loseAccess(error); throw error; }
      });
      queue = result.catch(() => {}); return result;
    } };
}
