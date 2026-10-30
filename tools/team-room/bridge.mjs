import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTeamClient, mentionsRoomMentor, updateAdviceStatuses, adviceStatusLabel, teamAccessLoss, roomProgressStatus } from './client.mjs';
import { createTeamPublisher } from './publisher.mjs';
import { createGameIdentity } from './game-identity.mjs';
import { applyTeamConfirmation } from './confirmation-apply.mjs';
import { createLocalRoomHost } from './local-host.mjs';
import { createShutdown } from '../cloud-desktop/shutdown.mjs';

export const TEAM_ERRORS = {
  local_byok_required: '请先在设置中选择自有模型并填写模型地址和名称。', local_byok_key_required: '请先在设置中保存自有模型密钥。',
  local_byok_endpoint_required: '自有模型需要使用独立于金宝服务的模型地址。',
  room_cache_cleanup_pending: '本机群缓存尚未清理完成，已暂停载入，请在维护与诊断中检查。',
  room_privacy_cleanup_pending: '消息已发出，队伍正在处理数据，金宝暂不能回答，请稍后重试。',
  local_host_restart_required: '本机群运行器未能完整关闭，请重启金宝后再开启主机。',
  local_dsh_incompatible: '本机 DSH 版本缺少群聊所需能力，请更新后重试。', local_host_credential_invalid: '本机群主机凭据无法读取，请重新授权。',
  local_host_already_enabled: '这台电脑已申请或启用群主机，请先停止并撤回。', local_host_unavailable: '本机群主机预览尚未开启。',
  invalid_host_proposal: '请填写设备名称和至少5万的累计授权上限。',
  host_offline: '群主机离线，暂不调用模型；普通聊天仍可使用。', host_budget_exhausted: '群主机授权额度不足，请重新核对上限。',
  host_change_busy: '还有队伍任务未结束，请稍后更换主机。', host_reconciliation_required: '群主机尚有待核对费用，暂不能更换。',
  host_authorization_required: '群主机授权已失效，请重新申请。', host_proposal_unavailable: '主机申请已过期或变化，请重新申请。',
  execution_change_busy: '还有任务或待核对费用，暂不能切换执行方式。', host_execution_disabled: '服务端尚未开放群主机执行。',
  connection_expired: '连接码已过期或申请已结束，请重新生成。', connection_claimed: '连接码已被另一端申请，请重新生成。',
  already_room_member: '这个登录账号已经是队伍成员，请先处理重复成员再连接。', connection_limit: '同一成员最多连接三个其他登录账号。',
  original_login_required: '请在最初加入队伍的登录端管理连接和预算。', connection_changed: '连接状态已变化，请重新发起。',
  invalid_connection: '请输入 6 位连接码，并填写设备名称。',
  confirmation_expired: '确认已过期、已由另一端处理或本轮选项已变化。', confirmation_unavailable: '这条确认不属于当前成员或已不可用。',
  invalid_confirmation_choice: '确认条件或选项已变化，请刷新后核对。',
  memory_cursor_changed: '记忆已更新，请重新检索。', memory_pending_limit: '你的待确认记忆已达50条，请先确认或删除已有提议。',
  login_required: '请先在设置中登录邮箱或微信账号。', email_login_refresh_required: '为区分队伍成员，请在设置中重新验证一次邮箱。',
  verified_login_required: '队伍需要个人登录身份，请使用邮箱或微信登录。', room_forbidden: '你已不在这个队伍中。',
  room_unavailable: '队伍已关闭或不存在。', room_full: '队伍最多 5 人，当前已满。', membership_removed: '你已被移出队伍，请联系群主。',
  original_owner_required: '请使用群主最初加入队伍的登录身份完成此操作。', room_recovery_expired: '恢复期限已过或正在清理，无法恢复队伍。', memory_outdated: '这条临时记忆属于解散前的大厅，只能删除。',
  room_creation_limit: '队伍成员的当前房间或可恢复房间数量已达上限，请先处理现有队伍。',
  room_budget_required: '群主尚未授权队伍预算，普通聊天仍可使用。', room_budget_exhausted: '队伍预算不足，请群主调整。',
  budget_reauthorization_required: '群主已变更，需要新群主重新授权预算。', room_queue_full: '金宝正在处理队友的问题，稍后再问。',
  no_current_match: '请先关联当前对局。', transfer_owner_first: '请先把群主转让给队友，再退出。',
  invite_unavailable: '邀请码无效或已过期，请群主重新生成。', rate_limited: '操作有些频繁，请稍后再试。',
  fresh_match_required: '请等待本机采集到当前对局，再开启队伍本局。', match_binding_unavailable: '本机与队伍的游戏不一致，或暂无新鲜对局信息。',
  invalid_room: '请先创建或加入一个队伍。', invalid_message: '请填写不超过 2000 字的消息。',
};

export async function createTeamBridge({ stateDir, serviceBaseUrl, getToken, getFacts = async () => null,
  fetchImpl = fetch, pollMs = 3000, now = Date.now, getGameIdentity = createGameIdentity({ now }), applyConfirmation, localHost }) {
  await mkdir(stateDir, { recursive: true });
  const settingsFile = join(stateDir, 'team-room-settings.json'), overlayFile = join(stateDir, 'team-room-overlay.json');
  let settings = { version: 1, activeRoomId: null, mode: 'personal', deviceId: randomUUID(), stateVersion: now(), binding: null, shareGameInfo: false };
  try {
    const saved = JSON.parse(await readFile(settingsFile, 'utf8'));
    if (/^[a-zA-Z0-9_-]{1,100}$/.test(saved.activeRoomId ?? '')) settings.activeRoomId = saved.activeRoomId;
    if (saved.mode === 'team') settings.mode = 'team';
    if (/^[a-f0-9-]{36}$/.test(saved.deviceId ?? '')) settings.deviceId = saved.deviceId;
    if (Number.isSafeInteger(saved.stateVersion)) settings.stateVersion = Math.max(settings.stateVersion, saved.stateVersion);
    if (saved.binding && typeof saved.binding.localMatch === 'string' && typeof saved.binding.roomMatchId === 'string') settings.binding = saved.binding;
    settings.shareGameInfo = saved.shareGameInfo === true;
    if (saved.pendingConnection?.expiresAt > now() && /^[a-zA-Z0-9_-]{1,100}$/.test(saved.pendingConnection.roomId ?? '')) settings.pendingConnection = saved.pendingConnection;
  } catch { /* first run */ }
  const client = createTeamClient({ serviceBaseUrl, getToken, fetchImpl });
  const host = localHost ? createLocalRoomHost({ ...localHost, reportFetchImpl: fetchImpl, stateDir, client, now, serviceBaseUrl }) : null;
  const suspendHost = async () => { try { await host?.suspend(); } catch {} };
  const publisher = createTeamPublisher({ client, deviceId: settings.deviceId, getFacts, nextVersion: () => ++settings.stateVersion, now });
  let current = { supported: true, mode: settings.mode, room: null, messages: [], tasks: [], memories: [], budget: null,
    connected: false, error: null, sharing: 'not_shared', personalAudio: true };
  let closed = false, timer, running = null, nextAttempt = 0, accessGeneration = 0, mutation = Promise.resolve(), io = Promise.resolve();
  const atomic = (file, value) => {
    const encoded = JSON.stringify(value);
    const job = io.catch(() => {}).then(async () => { await writeFile(file + '.tmp', encoded, { mode: 0o600 }); await rename(file + '.tmp', file); });
    io = job; return job;
  };
  const persist = () => atomic(settingsFile, settings);
  async function loseAccess(error) {
    const lost = teamAccessLoss(error);
    if (!lost) return;
    accessGeneration++;
    const previousRoom = settings.activeRoomId;
    current = { ...current, connected: false, room: null, messages: [], tasks: [], memories: [], confirmations: [], connections: null,
      budget: null, host: null, shareGameInfo: false, sharing: 'not_shared',
      error: lost === 'authentication' ? '登录已失效，请重新登录；群聊连接会在权限验证后恢复。' : TEAM_ERRORS[error.code] };
    if (lost === 'membership') settings.activeRoomId = null;
    settings.binding = null; settings.shareGameInfo = false; delete settings.pendingConnection; publisher.reset();
    await suspendHost();
    if (lost === 'membership') {
      try { await host?.endAccess(previousRoom); } catch { current.notice = '本机群缓存待清理，后续启动会继续重试。'; }
    }
    await persist(); await flush();
  }
  const view = () => structuredClone({ ...current,
    ...(host && current.host ? { host: { ...current.host, local: host.view() } } : {}), connectionPending: !!settings.pendingConnection });
  async function applyResponses(room, responses) {
    if (!settings.shareGameInfo || !applyConfirmation) return;
    for (const request of responses) {
      const outcome = await applyTeamConfirmation({ request, deviceId: settings.deviceId, facts: await getFacts(), binding: settings.binding, room, apply: applyConfirmation, now: now() });
      if (!outcome) continue;
      await client.respondConfirmation(room.id, { id: request.id, action: 'ack', deviceId: settings.deviceId, resolutionVersion: request.resolutionVersion, outcome });
      if (outcome === 'applied') { publisher.reset(); await publisher.tick({ room, binding: settings.binding }); }
      else current.notice = outcome === 'conflict' ? '两端记录的选择不一致，请核对实际选择。' : '旧确认已跳过，未写入当前对局。';
    }
  }
  async function flush() {
    const chatRows = current.messages.slice(-80).map(row => ({ role: row.role ?? 'user', displayName: row.displayName,
      text: adviceStatusLabel(row)?adviceStatusLabel(row)+'\n'+row.text:row.text, origin: 'team', seq: row.seq, replyTo: row.replyTo }));
    const status = roomProgressStatus(current, now());
    const output = { supported: true, mode: settings.mode, activeRoomId: settings.activeRoomId,
      roomName: current.room?.name ?? '', connected: current.connected, status: status || (current.room ? '' : '请先创建或加入队伍'),
      chatRows, chat: chatRows.map(row => `${row.displayName ?? (row.role === 'assistant' ? '金宝' : '队友')}：${row.text}`).join('\n\n'),
      updatedAt: now() };
    await atomic(overlayFile, output);
  }
  async function tick() {
    if (closed) return;
    if ((!settings.activeRoomId && !settings.pendingConnection) || now() < nextAttempt) { await flush(); return; }
    if (running) return running;
    const generation = accessGeneration;
    const checkAccess = () => { if (generation !== accessGeneration) throw Object.assign(new Error('access_changed_retry'), { code: 'access_changed_retry' }); };
    running = (async () => {
      try {
        if (settings.pendingConnection) {
          const pending = settings.pendingConnection;
          if (pending.expiresAt <= now()) {
            delete settings.pendingConnection; current.notice = '连接申请已过期，请重新发起。'; await persist(); return;
          }
          try { await client.get(pending.roomId); }
          catch (error) { if (error.code === 'room_forbidden') { current.notice = '等待原设备确认连接…'; return; } throw error; }
          settings.activeRoomId = pending.roomId; settings.mode = 'team'; settings.binding = null; settings.shareGameInfo = false;
          delete settings.pendingConnection; current.notice = '已连接，两端共用一个队伍成员。'; await persist();
        }
        let dashboard = await client.dashboard(settings.activeRoomId, current.room?.id === settings.activeRoomId ? current.messages.at(-1)?.seq ?? 0 : null,
          current.room?.id === settings.activeRoomId ? current.messages : null,
          current.room?.id === settings.activeRoomId ? current.room.privacyVersion ?? 0 : null);
        let room = dashboard.room;
        checkAccess();
        const facts = settings.shareGameInfo ? await getFacts() : null;
        const evidence = facts && now() - facts.at <= 30_000 ? await getGameIdentity(facts) : null;
        if (evidence && settings.shareGameInfo) {
          if (room.selfMemberId === room.ownerMemberId && room.currentMatch?.matchKey !== evidence.matchKey) {
            await client.startMatch(room.id, evidence.matchKey, facts.game, facts.mode ?? 'unknown');
            dashboard = await client.dashboard(room.id, current.messages.at(-1)?.seq ?? null, current.messages, current.room?.privacyVersion ?? 0); room = dashboard.room;
          }
          if (room.currentMatch?.matchKey === evidence.matchKey && room.currentMatch.game === facts.game) {
            settings.binding = { roomMatchId: room.currentMatch.id, localMatch: facts.match, game: facts.game };
          }
        }
        const messages = current.room?.id === room.id && !dashboard.resetMessages ? [...current.messages] : [];
        let pageResult = dashboard.messages, cursor;
        for (let page = 0; page < 10; page++) {
          const result = pageResult ?? await client.messages(room.id, cursor, 30); pageResult = null;
          messages.push(...result.items); cursor = result.cursor;
          if (!result.hasMore) break;
        }
        const { tasks, budget, memories, connections, confirmations } = dashboard;
        let hostState = null;
        checkAccess();
        if (host) {
          try { await host.preparePrivacy(room); const remote = await client.hostStatus(room.id); hostState = { ...remote, local: await host.synchronize(room, remote) }; }
          catch (error) { if (teamAccessLoss(error)) throw error; await suspendHost(); hostState = { local: host.view() }; }
        }
        checkAccess();
        const sharing = settings.shareGameInfo ? await publisher.tick({ room, binding: settings.binding }) : { state: 'not_shared' };
        checkAccess();
        await applyResponses(room, confirmations.items);
        checkAccess();
        current = { ...current, room, messages: updateAdviceStatuses(messages.slice(-500),dashboard.adviceUpdates,room), tasks: tasks.items, budget, memories: memories.items,
          connections, confirmations: confirmations.items, host: hostState, connected: true, error: null, sharing: sharing.state, shareGameInfo: settings.shareGameInfo, mode: settings.mode };
        await persist();
      } catch (error) {
        if (generation !== accessGeneration) return;
        await suspendHost();
        if (error.code === 'privacy_refresh_required' && current.room?.id && Number.isSafeInteger(error.privacyVersion)) {
          // The version has already advanced even if reloading messages failed.
          // Clear the local host cache without waiting for host-status recovery.
          try { await host?.preparePrivacy({ id: current.room.id, privacyVersion: error.privacyVersion }); } catch {}
        }
        nextAttempt = now() + ([401, 403, 404].includes(error.status) ? 30_000 : 5000);
        if (error.code === 'privacy_refresh_required') current = { ...current, messages: [], memories: [], room: current.room ? { ...current.room, privacyVersion: error.privacyVersion } : null };
        current = { ...current, connected: false, error: TEAM_ERRORS[error.code] ?? '队伍连接暂不可用，正在重试。' };
        await loseAccess(error);
      } finally { try { await flush(); } finally { running = null; } }
    })();
    return running;
  }
  async function perform(action, data = {}) {
    if (['create', 'join', 'open', 'restore'].includes(action)) await host?.suspend();
    if (settings.pendingConnection && ['create', 'join', 'open', 'restore', 'connect'].includes(action)) {
      await client.cancelConnection(settings.pendingConnection.roomId, settings.pendingConnection.requestId);
      delete settings.pendingConnection; await persist();
    }
    const roomId = settings.activeRoomId;
    let result;
    switch (action) {
      case 'host-propose': if (!host) throw Object.assign(new Error(), { code: 'local_host_unavailable' }); result = await host.propose(roomId, data); await tick(); return result;
      case 'host-withdraw': if (!host) throw Object.assign(new Error(), { code: 'local_host_unavailable' }); result = await host.withdraw(roomId); await tick(); return result;
      case 'host-approve': if (!host) throw Object.assign(new Error(), { code: 'local_host_unavailable' }); result = await client.approveHost(roomId, data.proposalId); await tick(); return result;
      case 'host-revoke': if (!host) throw Object.assign(new Error(), { code: 'local_host_unavailable' }); result = await client.revokeHost(roomId); await tick(); return result;
      case 'execution-mode': if (!host) throw Object.assign(new Error(), { code: 'local_host_unavailable' }); result = await client.setExecutionMode(roomId, data.mode); await tick(); return result;
      case 'list': return client.list();
      case 'closed-list': return client.closedRooms(data.after ?? 0, data.limit ?? 20);
      case 'restore': result = await client.restore(data.roomId); break;
      case 'create': result = await client.create(data.name, data.displayName); break;
      case 'join': result = await client.join(data.code, data.displayName); break;
      case 'open': result = await client.get(data.roomId); break;
      case 'invite': return client.invite(roomId);
      case 'connection-code': return client.connectionCode(roomId);
      case 'connection-update': result = await client.updateConnection(roomId, data.action, data.connectionId); await tick(); return result;
      case 'connect':
        result = await client.claimConnection(data.code, data.deviceName);
        settings.pendingConnection = result; current.notice = '等待原设备确认连接…';
        nextAttempt = 0; await persist(); await tick(); return result;
      case 'cancel-connection':
        if (settings.pendingConnection) await client.cancelConnection(settings.pendingConnection.roomId, settings.pendingConnection.requestId);
        delete settings.pendingConnection; current.notice = null; await persist(); await flush(); return { cancelled: true };
      case 'history': return client.messages(roomId, data.after ?? 0, data.limit ?? 50);
      case 'memory-query': return client.memories(roomId, data.query ?? '', true, data);
      case 'sharing':
        if (typeof data.enabled !== 'boolean') throw new Error('invalid_sharing');
        settings.shareGameInfo = data.enabled;
        if (!data.enabled) settings.binding = null;
        current.shareGameInfo = data.enabled; publisher.reset(); await persist(); await tick(); return view();
      case 'mode':
        if (!['team', 'personal'].includes(data.mode)) throw new Error('invalid_mode');
        settings.mode = data.mode; current.mode = data.mode; await persist(); await flush(); return view();
      case 'send': {
        const text = String(data.text ?? '').trim();
        if (!text || text.length > 2000) throw new Error('invalid_message');
        const message = await client.send(roomId, { clientMessageId: data.clientMessageId ?? randomUUID(), text,
          ask: data.ask === true || mentionsRoomMentor(text, current.room), replyTo: data.replyTo ?? null });
        let admission = null;
        if (message.message.trigger === 'ask') {
          try { await client.enqueue(roomId, message.message.seq); }
          catch (error) { if (teamAccessLoss(error)) throw error; admission = { accepted: false, message: TEAM_ERRORS[error.code] ?? '消息已发出，但金宝暂未接受提问，请稍后重新提交提问。' }; }
        }
        await tick(); current.notice = admission?.message ?? null; await flush();
        return { ...message, admission };
      }
      case 'ask-existing': result = await client.enqueue(roomId, data.messageSeq); await tick(); return result;
      case 'budget': result = await client.authorizeBudget(roomId, data.maxTokens); await tick(); return result;
      case 'automatic': result = await client.setAutomaticAdvice(roomId, data.enabled); await tick(); return result;
      case 'recap': result = await client.setPostGameRecap(roomId, data.enabled); await tick(); return result;
      case 'role': result = await client.setMentorRole(roomId, data.role); await tick(); return result;
      case 'confirmation': return client.respondConfirmation(roomId, { ...data, deviceId: settings.deviceId });
      case 'local-confirmation': {
        const request = current.confirmations?.find(item => ['pending', 'assumed'].includes(item.status) && item.localConfirmationId === data.id && item.sourceDeviceId === settings.deviceId);
        if (!request) throw Object.assign(new Error(), { code: 'confirmation_expired', status: 409 });
        const choice = request.options.find(option => option.name === data.name);
        result = await client.respondConfirmation(roomId, { id: request.id, deviceId: settings.deviceId, action: data.dismiss ? 'dismiss' : 'select', optionId: choice?.id });
        await applyResponses(current.room, [result]); await tick(); return { confirmed: result.status === 'confirmed' };
      }
      case 'remove': result = await client.remove(roomId, data.memberId); await tick(); return result;
      case 'transfer': result = await client.transfer(roomId, data.memberId); await tick(); return result;
      case 'memory-propose': result = await client.proposeMemory(roomId, data); await tick(); return result;
      case 'memory-update': result = await client.updateMemory(roomId, data.memoryId, data.action, data.content); await tick(); return result;
      case 'start-match': {
        const facts = await getFacts();
        if (!facts?.match || !facts.game || now() - facts.at > 30_000) throw new Error('fresh_match_required');
        const evidence = await getGameIdentity(facts);
        result = await client.startMatch(roomId, evidence?.matchKey ?? randomUUID(), facts.game, facts.mode ?? 'unknown');
        settings.binding = { roomMatchId: result.id, localMatch: facts.match, game: facts.game };
        settings.shareGameInfo = true;
        publisher.reset(); await persist(); await tick(); return result;
      }
      case 'bind-match': {
        const facts = await getFacts(), room = await client.get(roomId);
        if (!facts?.match || !room.currentMatch || room.currentMatch.game !== facts.game || now() - facts.at > 30_000) throw new Error('match_binding_unavailable');
        settings.binding = { roomMatchId: room.currentMatch.id, localMatch: facts.match, game: facts.game };
        settings.shareGameInfo = true;
        publisher.reset(); await persist(); await tick(); return { bound: true };
      }
      case 'leave': case 'dissolve':
        if (action === 'dissolve') await client.dissolve(roomId); else await client.leave(roomId);
        await host?.synchronize(null);
        publisher.reset(); settings.activeRoomId = null; settings.mode = 'personal'; settings.binding = null; settings.shareGameInfo = false;
        delete settings.pendingConnection;
        current = { ...current, room: null, messages: [], tasks: [], memories: [], confirmations: [], connections: null, budget: null, connected: false, shareGameInfo: false, sharing: 'not_shared', error: null, mode: 'personal' };
        await persist(); await flush(); return { left: true };
      default: throw new Error('invalid_team_action');
    }
    delete settings.pendingConnection;
    settings.activeRoomId = result.id; settings.binding = null; settings.mode = 'team'; settings.shareGameInfo = false;
    current = { ...current, room: null, messages: [], tasks: [], memories: [], budget: null, mode: 'team', error: null };
    nextAttempt = 0; publisher.reset(); await persist(); await tick(); return view();
  }
  const command = (action, data) => {
    const job = mutation.then(async () => {
      if (closed) throw new Error('team_closed');
      try { return await perform(action, data); }
      catch (error) { await loseAccess(error); error.userMessage = TEAM_ERRORS[error.code ?? error.message] ?? '队伍操作未完成，请检查输入、登录或稍后重试。'; throw error; }
    });
    mutation = job.catch(() => {}); return job;
  };
  await flush();
  timer = setInterval(() => { void tick().catch(() => {}); }, pollMs); timer.unref();
  if (settings.activeRoomId) void tick().catch(() => {});
  const stopAccepting = () => { closed = true; clearInterval(timer); host?.quiesce(); };
  const stop = createShutdown({ quiesce: stopAccepting,
    steps: [['commands', () => mutation], ['host', () => host?.close()], ['poll', () => running],
      ['overlay', () => atomic(overlayFile, { supported: false, updatedAt: now() })], ['io', () => io]] });
  return { view, command, tick, stopAccepting,
    reconfigureHost: () => host?.reconfigure(),
    canConfirmLocal: id => !!current.confirmations?.some(item => ['pending', 'assumed'].includes(item.status) && item.localConfirmationId === id && item.sourceDeviceId === settings.deviceId),
    async close() { if ((await stop()).failed.length) throw new Error('team_shutdown_failed'); } };
}
