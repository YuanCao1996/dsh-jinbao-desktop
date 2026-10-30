import { roomMentorName, adviceStatusLabel, roomProgressStatus, unchangedSentDraft } from './client.mjs';
const incomingNonce = location.hash.slice(1);
if (/^[a-f0-9]{64}$/.test(incomingNonce)) sessionStorage.setItem('jinbao-team-setup', incomingNonce);
const nonce = incomingNonce || sessionStorage.getItem('jinbao-team-setup') || '';
history.replaceState(null, '', location.pathname);
const $ = id => document.getElementById(id);
$('settingsLink').href = '/#' + nonce;
const nativeMode = !!globalThis.JinbaoTeamNative;
let nativeApi;
if (nativeMode) {
  ({ nativeApi } = await import('./native-api.mjs'));
  document.documentElement.classList.add('native-team');
  $('settingsLink').textContent = '返回'; $('settingsLink').href = '#';
  $('settingsLink').onclick = event => { event.preventDefault(); globalThis.JinbaoTeamNative.close(); };
  $('mobileSettings').onclick = () => {
    const open = document.documentElement.classList.toggle('team-settings-open');
    $('mobileSettings').setAttribute('aria-expanded', String(open));
    $('mobileSettings').textContent = open ? '收起队伍设置' : '队伍设置';
  };
}
let state, roomKey = '', rendered = '', replyTo = null, busy = false, sendingId = null;
let draftRevision = 0;
const draft = () => ({ revision: draftRevision, roomId: state?.room?.id, text: $('question').value, ask: $('ask').checked, replyTo });
let earlier = new Map(), memorySearch = null;
let closedCursor = 0;
let confirmationKey = '', confirmationClock = null, confirmationPulse = false, confirmationNextPulse = 0, confirmationSubmitting = false,
  nativeVisible = !nativeMode || typeof globalThis.JinbaoTeamNative.isVisible !== 'function' || globalThis.JinbaoTeamNative.isVisible();
const confirmationVisible = () => !document.hidden && nativeVisible;
const remainingConfirmation = () => confirmationClock ? Math.max(0, confirmationClock.remaining - (confirmationClock.active ? performance.now() - confirmationClock.at : 0)) : 0;
function calibrateConfirmation(prompt) { confirmationClock = { id: prompt.id, remaining: prompt.remainingMs, at: performance.now(), active: confirmationVisible() }; }
async function pulseConfirmation() {
  const prompt = state?.confirmations?.at(-1);
  if (!prompt || prompt.status !== 'pending' || confirmationPulse) return;
  confirmationPulse = true; confirmationNextPulse = Date.now() + 2000;
  try { const result = await api('confirmation', { id: prompt.id, action: 'visibility', visible: confirmationVisible() });
    if (state?.confirmations?.at(-1)?.id === result.id) { state.confirmations[state.confirmations.length - 1] = result; calibrateConfirmation(result); }
  } catch { confirmationNextPulse = Date.now() + 5000; }
  finally { confirmationPulse = false; }
}
function confirmationVisibilityChanged() {
  if (confirmationClock) confirmationClock = { ...confirmationClock, remaining: remainingConfirmation(), at: performance.now(), active: confirmationVisible() };
  void pulseConfirmation();
}
document.addEventListener('visibilitychange', confirmationVisibilityChanged);
window.addEventListener('jinbaoTeamVisibility', event => { nativeVisible = event.detail === true; confirmationVisibilityChanged(); });
function renderConfirmation() {
  const prompt = state?.room && state.confirmations?.at(-1);
  const show = prompt && prompt.expiresAt > Date.now() && (['pending', 'assumed'].includes(prompt.status) || prompt.status === 'confirmed' && !prompt.acknowledged);
  $('confirmationCard').hidden = !show;
  if (!show) { confirmationKey = ''; confirmationClock = null; return; }
  const key = JSON.stringify([prompt.id, prompt.status, prompt.choice, prompt.options, prompt.resolutionVersion]);
  if (confirmationClock?.id !== prompt.id) { calibrateConfirmation(prompt); confirmationNextPulse = 0; }
  else if (!confirmationSubmitting) calibrateConfirmation(prompt);
  if (key === confirmationKey) return;
  confirmationKey = key;
  $('confirmationTitle').textContent = prompt.status === 'confirmed' ? `已确认：${prompt.choice.name}` : prompt.title;
  $('confirmationOptions').replaceChildren();
  if (prompt.status === 'confirmed') { $('confirmationHint').textContent = '等待采集电脑同步；不会替你操作游戏。'; return; }
  for (const option of prompt.options) $('confirmationOptions').append(button((option.id === prompt.defaultOptionId ? '默认 · ' : '') + option.name, async () => {
    if (confirmationSubmitting) return; confirmationSubmitting = true;
    try { await command('confirmation', { id: prompt.id, action: 'select', optionId: option.id }); feedback('已记录实际选择，正在同步采集端。'); }
    finally { confirmationSubmitting = false; }
  }));
  $('confirmationOptions').append(button('暂不确认', () => command('confirmation', { id: prompt.id, action: 'dismiss' })));
  $('confirmationHint').textContent = prompt.status === 'assumed' ? `默认推测：${prompt.choice.name}。点击实际选择可更正。` : '按当前选项推荐顺序排列，默认项仅作推测。';
}
setInterval(() => {
  const prompt = state?.room && state.confirmations?.at(-1);
  if (!prompt || prompt.status !== 'pending' || $('confirmationCard').hidden) return;
  const remaining = remainingConfirmation();
  $('confirmationHint').textContent = confirmationVisible() ? `${Math.ceil(remaining / 1000)} 秒后按默认项推测；点击实际选择可确认。` : '已暂停倒计时';
  if (Date.now() >= confirmationNextPulse) void pulseConfirmation();
  if (remaining <= 0 && confirmationVisible() && !confirmationSubmitting && !confirmationPulse && Date.now() >= confirmationNextPulse - 1500) {
    confirmationSubmitting = true;
    void command('confirmation', { id: prompt.id, action: 'select', optionId: prompt.defaultOptionId, timeoutDefault: true })
      .catch(() => { confirmationNextPulse = Date.now() + 5000; }).finally(() => { confirmationSubmitting = false; });
  }
}, 250);
let dialogResolve = null;
function showDialog(message, initial) {
  if (dialogResolve) return Promise.resolve(null);
  $('dialogMessage').textContent = message;
  $('dialogInputLabel').hidden = initial === undefined;
  $('dialogInput').value = initial ?? '';
  $('dialogTitle').textContent = initial === undefined ? '确认操作' : '更正记忆';
  $('confirmDialog').showModal();
  return new Promise(resolve => { dialogResolve = resolve; });
}
function finishDialog(accepted) {
  if (!dialogResolve) return;
  const result = accepted ? $('dialogInputLabel').hidden ? true : $('dialogInput').value : null;
  const resolve = dialogResolve; dialogResolve = null; $('confirmDialog').close(); resolve(result);
}
$('dialogAccept').onclick = () => finishDialog(true);
$('dialogCancel').onclick = () => finishDialog(false);
$('confirmDialog').addEventListener('cancel', event => { event.preventDefault(); finishDialog(false); });
const feedback = text => { $('feedback').textContent = text ?? ''; };
async function api(action, data) {
  if (nativeMode) return nativeApi(action, data);
  const response = await fetch(action ? '/api/team/command' : '/api/team/status', {
    method: action ? 'POST' : 'GET', headers: { 'X-Jinbao-Setup': nonce, ...(action ? { 'Content-Type': 'application/json' } : {}) },
    ...(action ? { body: JSON.stringify({ action, data: data ?? {} }) } : {}),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? '操作暂不可用');
  return value;
}
async function run(fn) { try { await fn(); } catch (error) { feedback(error.message); } }
async function command(action, data) { const result = await api(action, data); await refresh(); return result; }
function button(text, fn, className = 'secondary') {
  const node = document.createElement('button'); node.type = 'button'; node.textContent = text; node.className = className;
  node.onclick = () => run(fn); return node;
}
function reply(message) {
  draftRevision++; sendingId = null; replyTo = message.seq; $('reply').hidden = false;
  $('reply').replaceChildren(document.createTextNode(`回复 #${message.seq} · ${message.displayName ?? '金宝'} `), button('取消', () => { draftRevision++; sendingId = null; replyTo = null; $('reply').hidden = true; }));
  if (message.role === 'assistant') $('ask').checked = true;
  $('question').focus();
}
function remember(message) {
  $('memory').open = true; $('memoryText').value = message.text.slice(0, 500); $('memoryEvidence').value = message.seq;
  $('memoryText').focus();
}
function renderMessages() {
  const merged = new Map([...earlier, ...state.messages.map(message => [message.seq, message])]);
  const messages = [...merged.values()].sort((a, b) => a.seq - b.seq);
  const key = messages.map(message => `${message.seq}:${message.adviceStatus??''}:${message.text}`).join('|') + '|' + state.tasks.map(task => `${task.messageSeq}:${task.status}`).join(',');
  if (key === rendered) return;
  rendered = key;
  const area = $('messages'), follow = area.scrollHeight - area.scrollTop - area.clientHeight < 36;
  const offset = area.scrollTop, height = area.scrollHeight;
  const nodes = messages.map(message => {
    const node = document.createElement('article'); node.className = 'message' + (message.role === 'assistant' ? ' assistant' : '');
    const header = document.createElement('header'); header.textContent = `${message.displayName ?? '金宝'} · #${message.seq}${message.replyTo ? ` · 回复 #${message.replyTo}` : ''}`;
    const body = document.createElement('div'); body.textContent = message.text;
    const footer = document.createElement('footer'); footer.append(button('回复', () => reply(message)), button('记住', () => remember(message)));
    if (message.memberId === state.room.selfMemberId && message.trigger === 'ask' && !state.tasks.some(task => task.messageSeq === message.seq)) {
      footer.append(button('重试提问', () => command('ask-existing', { messageSeq: message.seq })));
    }
    node.append(header);
    const label=adviceStatusLabel(message);if(label){const notice=document.createElement('p');notice.className='muted';notice.textContent=label;node.append(notice);}
    node.append(body, footer); return node;
  });
  area.replaceChildren(...nodes);
  if (follow && !earlier.size) area.scrollTop = area.scrollHeight;
  else { area.scrollTop = earlier.size ? offset + Math.max(0, area.scrollHeight - height) : offset; $('latest').hidden = false; }
  $('older').hidden = !messages.length || messages[0].seq <= 1;
}
function render() {
  const room = state.room, owner = room?.selfMemberId === room?.ownerMemberId;
  const host = state.host;
  $('hostPanel').hidden = !room || !host;
  if (room && host) {
    const states = { stopped: '本机未启用', waiting_approval: '等待群主批准主机申请', authorization_required: '授权已失效，请重新申请',
      route_required: '主机已获批，等待群主选择自有模型执行', service_disabled: '服务端尚未开放主机执行',
      connected: '本机已连接', working: '正在处理队伍问题', offline: '本机已暂停或连接中断', task_failed: '本次任务未完成', cleanup_pending: '本机缓存待清理，已停止模型执行', unavailable: '请检查本机自有模型设置、DSH 和连接' };
    $('localHostState').textContent = host.local ? states[host.local.state] ?? '本机状态待检查' : '手机可管理电脑主机授权，不承载模型或保存电脑密钥。';
    $('hostExplanation').textContent = host.local
      ? '复用电脑设置中的自有模型密钥和本机 DSH。密钥只存本机，群主仍需批准房间预算和主机申请。主机离线时不会改用官方模型。'
      : '电脑成员先申请承载，群主原登录端批准后再选择执行方式。电脑离线时暂停回答，普通聊天仍可使用。';
    $('hostSummary').textContent = host.configured ? `${host.deviceName ?? '群主机'} · ${host.online ? '在线' : '离线'}${Number.isSafeInteger(host.maxTokens) ? ` · 授权上限 ${host.maxTokens.toLocaleString()}` : ''}` : '尚无已授权群主机';
    $('hostProposalForm').hidden = !host.local?.supported || host.local.enabled;
    $('withdrawHost').hidden = !host.local?.enabled;
    $('hostOwnerControls').hidden = !host.canApprove;
    $('revokeHost').hidden = !host.configured;
    $('executionMode').value = room.executionMode ?? 'official';
    $('hostRequests').replaceChildren(...(host.proposals ?? []).map(proposal => {
      const row = document.createElement('p');
      row.textContent = `${proposal.deviceName} · 上限 ${proposal.maxTokens.toLocaleString()} token`;
      if (host.canApprove) row.append(button('批准', async () => {
        if (await showDialog(`批准“${proposal.deviceName}”使用它自己的模型密钥为队伍提供服务？此操作不会自动切换执行方式，房间预算仍需单独授权。`)) await command('host-approve', { proposalId: proposal.id });
      }));
      else row.append(document.createTextNode(' · 等待群主批准'));
      return row;
    }));
  }
  $('dissolve').hidden = !room?.canAuthorizeBudget;
  $('welcome').hidden = !!room; $('roomShell').hidden = !room;
  $('connectionEntry').hidden = !!room; $('mobileSettings').hidden = !nativeMode || !room;
  renderConfirmation();
  $('cancelConnection').hidden = !state.connectionPending;
  $('gameCollectorControls').hidden = nativeMode && !state.collectionSupported;
  if (nativeMode) {
    $('startMatch').disabled = !state.collectionAvailable; $('bindMatch').disabled = !state.collectionAvailable;
    $('chatMode').parentElement.hidden = true;
  }
  if (!room) { roomKey = ''; earlier = new Map(); memorySearch = null; rendered = ''; replyTo = null; $('reply').hidden = true; $('messages').replaceChildren(); $('memoryRows').replaceChildren(); $('title').textContent = '一起开黑，一起问金宝'; if (state.error || state.notice) feedback(state.error ?? state.notice); return; }
  const privacyKey = room.id + ':' + (room.privacyVersion ?? 0);
  if (roomKey !== privacyKey) { roomKey = privacyKey; earlier = new Map(); memorySearch = null; rendered = ''; replyTo = null; $('reply').hidden = true; feedback(state.notice ?? state.error ?? ''); }
  $('title').textContent = room.name; $('memberCount').textContent = `${room.members.length}/5`;
  const mentorName = roomMentorName(room);
  $('askLabel').textContent = '问' + mentorName;
  $('question').placeholder = `和队友聊聊，或 @${mentorName} 提问`;
  $('connection').textContent = state.connected ? '已连接' : '连接中';
  $('progress').textContent = roomProgressStatus(state);
  $('members').replaceChildren(...room.members.map(member => {
    const node = document.createElement('div'); node.className = 'member';
    node.textContent = member.displayName + (member.id === room.ownerMemberId ? ' · 群主' : '') + (member.id === room.selfMemberId ? ' · 你' : '');
    if (owner && member.id !== room.selfMemberId) {
      node.append(button('转让', async () => { if (await showDialog(`将群主转让给 ${member.displayName}？新群主需要重新授权预算。`)) await command('transfer', { memberId: member.id }); }),
        button('移除', async () => { if (await showDialog(`将 ${member.displayName} 移出队伍？`)) await command('remove', { memberId: member.id }); }));
    }
    return node;
  }));
  $('invitePanel').hidden = !owner; $('budgetOwner').hidden = !room.canAuthorizeBudget; $('startMatch').hidden = !owner;
  $('interactionOwner').hidden = !owner;
  const roleOptions = room.mentorRoles ?? [];
  if ($('mentorRole').options.length !== roleOptions.length) $('mentorRole').replaceChildren(...roleOptions.map(role => {
    const option = document.createElement('option'); option.value = role.id; option.textContent = role.name + ' · ' + role.description; return option;
  }));
  $('mentorRole').value = room.mentorRole ?? 'jinbao';
  $('mentorSummary').textContent = '当前导师：' + (roleOptions.find(role => role.id === room.mentorRole)?.name ?? '金宝');
  const connections = state.connections;
  $('connectionManager').hidden = !connections?.canManage;
  $('connectionRequests').replaceChildren();
  if (connections?.pending) {
    const pending = connections.pending;
    $('connectionRequests').append(document.createTextNode(`${pending.deviceName} 请求连接为你本人。`),
      button('确认是我的设备', async () => { if (await showDialog(`确认 ${pending.deviceName} 是你自己的设备？确认后将能以你的成员身份查看群历史、发消息和参与队伍。`)) await command('connection-update', { action: 'approve', connectionId: pending.requestId }); }),
      button('拒绝', () => command('connection-update', { action: 'reject', connectionId: pending.requestId })));
  }
  $('linkedDevices').replaceChildren(...(connections?.items ?? []).map(link => {
    const row = document.createElement('div'); row.textContent = link.deviceName;
    if (connections.canManage) row.append(button('断开', async () => { if (await showDialog(`断开 ${link.deviceName} 的队伍成员连接？`)) await command('connection-update', { action: 'revoke', connectionId: link.id }); }));
    return row;
  }));
  const gameNames = { lol: '英雄联盟', wzry: '王者荣耀', generic: '通用游戏' };
  const modeNames = { KIWI: '海克斯大乱斗', 'hextech-aram': '海克斯大乱斗', ARAM: '极地大乱斗' };
  $('match').textContent = room.currentMatch ? `${gameNames[room.currentMatch.game] ?? room.currentMatch.game} · ${modeNames[room.currentMatch.mode] ?? room.currentMatch.mode}` : '尚未关联对局';
  $('sharing').textContent = ({ sharing: '正在共享本机整理后的信息', binding_required: '请确认本机和队友正在同一局，再关联当前局', waiting_fresh_state: '等待新鲜游戏信息', not_shared: '尚未共享', match_ended: '本局已结束，下一局需要重新关联', login_required: '请重新登录后开启共享', team_unavailable: '共享暂不可用，正在重试' })[state.sharing] ?? state.sharing;
  if (nativeMode) {
    if (!state.collectionSupported) $('sharing').textContent = '这里参与队伍聊天；当前对局由正在采集游戏的一端关联。';
    else $('collectionNote').textContent = '共享手机已识别的王者英雄、阵容、等级、时间与比分。每局确认一次属于队伍同局；不额外截图，不上传原始内容。';
  }
  $('chatMode').value = state.mode; $('automatic').checked = room.automaticAdvice;
  $('postGameRecap').checked = room.postGameRecap !== false;
  $('shareGameInfo').checked = state.shareGameInfo === true;
  const budget = state.budget;
  $('budgetRoute').textContent = room.executionMode === 'byok'
    ? '使用电脑的自有模型密钥；房间上限与电脑授权上限同时生效。资料查询仍按账号现有规则处理。'
    : '使用金宝官方云端模型，由群主明确授权的房间预算承担。';
  const held = budget?.reconciliationReserved ?? 0, processing = Math.max(0, (budget?.reserved ?? 0) - held);
  $('budget').textContent = budget?.authorized ? `可用 ${budget.remaining.toLocaleString()} · 已用 ${budget.spent.toLocaleString()}${processing ? ` · 处理中 ${processing.toLocaleString()}` : ''}${held ? ` · 待核对 ${held.toLocaleString()}` : ''}`
    : budget?.requiresReauthorization ? `需当前群主重新授权预算${held ? ` · 待核对 ${held.toLocaleString()}` : ''}，普通聊天可用` : '尚未授权预算，普通聊天可用';
  if (memorySearch && room.memoryVersion > memorySearch.memoryVersion) memorySearch = null;
  $('moreMemories').hidden = !memorySearch?.hasMore;
  $('memoryRows').replaceChildren(...(memorySearch?.items ?? state.memories).map(memory => {
    const node = document.createElement('div'); node.className = 'memory-row';
    const copy = document.createElement('p'); copy.textContent = `${memory.status === 'pending' ? '待确认 · ' : ''}${memory.content}`; node.append(copy);
    const personal = ['profile', 'preference'].includes(memory.type), editable = personal ? memory.subjectMemberId === room.selfMemberId : owner;
    if (editable) {
      if (memory.status === 'pending') node.append(button('确认', () => command('memory-update', { memoryId: memory.id, action: 'approve' })));
      node.append(button('修改', async () => { const content = await showDialog('修改后立即生效，并使旧的模型记忆上下文失效。', memory.content); if (content?.trim()) await command('memory-update', { memoryId: memory.id, action: 'correct', content: content.trim() }); }),
        button('删除', async () => { if (await showDialog('删除这条记忆？')) await command('memory-update', { memoryId: memory.id, action: 'delete' }); }));
    }
    return node;
  }));
  renderMessages();
}
async function refresh() { if (busy) return; busy = true; try { state = await api(); render(); } finally { busy = false; } }
$('create').onclick = () => run(async () => { await command('create', { name: $('roomName').value.trim(), displayName: $('nickname').value.trim() }); feedback('队伍已创建。'); });
$('join').onclick = () => run(async () => { await command('join', { code: $('joinCode').value.trim(), displayName: $('nickname').value.trim() }); feedback('已加入队伍。'); });
$('loadRooms').onclick = () => run(async () => { const result = await api('list'); $('rooms').replaceChildren(...result.items.map(room => button(room.name, () => command('open', { roomId: room.id })))); if (!result.items.length) feedback('你还没有加入队伍。'); });
$('invite').onclick = () => run(async () => { $('inviteCode').textContent = (await api('invite')).code; });
$('generateConnection').onclick = () => run(async () => { $('connectionCodeOutput').textContent = (await api('connection-code')).code; });
$('connectDevice').onclick = () => run(async () => { await command('connect', { code: $('connectionCodeInput').value.trim(), deviceName: $('connectionDevice').value.trim() }); feedback('申请已发出，请在原设备确认。'); });
$('cancelConnection').onclick = () => run(async () => { await command('cancel-connection'); feedback('已取消连接申请。'); });
$('leave').onclick = () => run(async () => { if (await showDialog('退出这个队伍？重新加入需要邀请码。')) await command('leave'); });
$('dissolve').onclick = () => run(async () => {
  if (await showDialog('解散整个队伍？所有成员将停止访问。聊天与共同记忆保留30天可恢复，到期删除。已发生或待核对的费用不会取消。')) {
    await command('dissolve'); feedback('队伍已解散，30天内可在“已解散的队伍”中恢复。');
  }
});
async function loadClosed(append = false) {
  const page = await api('closed-list', { after: append ? closedCursor : 0, limit: 20 });
  if (!append) $('closedRows').replaceChildren();
  for (const room of page.items) {
    const row = document.createElement('p');
    row.append(document.createTextNode(`${room.name} · 恢复期限 ${new Date(room.restoreUntil).toLocaleDateString('zh-CN')} `));
    row.append(button('恢复队伍', async () => {
      if (await showDialog('恢复聊天、共同记忆和原成员？不会恢复旧对局、待执行任务、主机授权或预算。')) {
        await command('restore', { roomId: room.id }); await loadClosed(); feedback('队伍已恢复。请重新授权预算，并关联新的对局。');
      }
    }));
    $('closedRows').append(row);
  }
  closedCursor = page.cursor; $('moreClosed').hidden = !page.hasMore;
  if (!append && !page.items.length) $('closedRows').textContent = '当前登录身份没有可恢复的队伍。';
}
$('loadClosed').onclick = () => run(() => loadClosed());
$('moreClosed').onclick = () => run(() => loadClosed(true));
$('startMatch').onclick = () => run(async () => { if (await showDialog('确认队伍开始一局新游戏？将切换本局状态和工作会话。')) await command('start-match'); });
$('bindMatch').onclick = () => run(async () => { if (await showDialog('确认你和队友正在同一局游戏，并共享本机整理后的游戏信息？')) await command('bind-match'); });
$('chatMode').onchange = () => run(() => command('mode', { mode: $('chatMode').value }));
$('shareGameInfo').onchange = () => run(async () => {
  const enabled = $('shareGameInfo').checked;
  if (!enabled || await showDialog('共享整理后的英雄、装备、海克斯和关键事件给队伍？不共享私人聊天、原始日志或截图。')) await command('sharing', { enabled });
  else $('shareGameInfo').checked = false;
});
$('authorize').onclick = () => run(async () => {
  const maxTokens = Number($('budgetLimit').value);
  const route = state.room?.executionMode === 'byok' ? '队伍使用已授权电脑的自有模型密钥，模型费用由该密钥承担；资料查询按账号现有规则处理。' : '队伍使用金宝官方云端模型，使用你的账号额度。';
  if (Number.isSafeInteger(maxTokens) && maxTokens >= 50_000 && maxTokens <= 100000000
    && await showDialog(`${route}授权本房间累计上限 ${maxTokens.toLocaleString()} token？这是预算上限，不会一次扣完。`)) await command('budget', { maxTokens });
});
$('automatic').onchange = () => run(() => command('automatic', { enabled: $('automatic').checked }));
$('postGameRecap').onchange = () => run(() => command('recap', { enabled: $('postGameRecap').checked }));
$('mentorRole').onchange = () => run(() => command('role', { role: $('mentorRole').value }));
$('proposeHost').onclick = () => run(async () => {
  const maxTokens = Number($('hostLimit').value), deviceName = $('hostDeviceName').value.trim();
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 50000 || maxTokens > 100000000 || !deviceName) { feedback('请填写电脑名称及5万至1亿的累计 token 上限。'); return; }
  if (await showDialog(`授权这台电脑使用设置中的自有模型密钥，累计最多 ${maxTokens.toLocaleString()} token？群内问题会交给本机 DSH，群成员不会获得你的密钥。`)) {
    await command('host-propose', { deviceName, maxTokens }); feedback('申请已提交，请群主批准后选择自有模型执行方式。');
  }
});
$('withdrawHost').onclick = () => run(async () => {
  if (await showDialog('停止本机群任务并撤回主机授权？已发生或待核对的费用仍保留，队伍不会自动切回官方模型。')) await command('host-withdraw');
});
$('revokeHost').onclick = () => run(async () => {
  if (await showDialog('撤销当前群主机？正在执行的旧任务将停止发布，已发生费用仍按证据处理。')) await command('host-revoke');
});
$('executionMode').onchange = () => run(async () => {
  const mode = $('executionMode').value;
  if (await showDialog(mode === 'byok' ? '将队伍模型交给已授权电脑？主机离线会暂停回答，普通聊天可用。' : '切换为金宝官方云端模型？后续群模型任务使用群主明确授权的房间预算。')) await command('execution-mode', { mode });
  else $('executionMode').value = state.room.executionMode ?? 'official';
});
$('composer').onsubmit = event => { event.preventDefault(); run(async () => {
  const text = $('question').value.trim(); if (!text || $('send').disabled) return;
  $('send').disabled = true; sendingId ??= crypto.randomUUID();
  const sent = draft();
  try {
    const result = await command('send', { text, ask: $('ask').checked, replyTo, clientMessageId: sendingId });
    if (unchangedSentDraft(sent, draft())) {
      $('question').value = ''; sendingId = null; replyTo = null; $('reply').hidden = true;
    }
    feedback(result.admission?.message ?? ''); $('messages').scrollTop = $('messages').scrollHeight;
  } finally { $('send').disabled = false; }
}); };
$('question').addEventListener('input', () => { draftRevision++; sendingId = null; });
$('ask').addEventListener('change', () => { draftRevision++; sendingId = null; });
$('question').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('composer').requestSubmit(); } };
$('latest').onclick = () => { $('messages').scrollTop = $('messages').scrollHeight; $('latest').hidden = true; };
$('older').onclick = () => run(async () => {
  const scope = roomKey;
  const first = Math.min(...state.messages.map(message => message.seq), ...earlier.keys());
  const result = await api('history', { after: Math.max(0, first - 51), limit: 50 });
  if (scope !== roomKey) return;
  for (const message of result.items) earlier.set(message.seq, message);
  renderMessages();
});
$('proposeMemory').onclick = () => run(async () => {
  const type = $('memoryType').value;
  await command('memory-propose', { clientMemoryId: crypto.randomUUID(), type, content: $('memoryText').value.trim(),
    evidenceSeq: Number($('memoryEvidence').value), ...(['profile', 'preference'].includes(type) ? { subjectMemberId: state.room.selfMemberId } : {}) });
  feedback('记忆提议已提交，确认后生效。');
});
async function findMemories(more = false) {
  if (more && !memorySearch) return;
  const roomId = state.room?.id;
  const query = more ? memorySearch.query : $('memoryQuery').value.trim(), type = more ? memorySearch.type : $('memoryFilter').value;
  const page = await api('memory-query', { query, ...(type ? { type } : {}), limit: 30,
    ...(more ? { cursor: memorySearch.cursor, memoryVersion: memorySearch.memoryVersion } : {}) });
  if (state.room?.id !== roomId) return;
  const rows = more ? [...(memorySearch?.items ?? []), ...page.items] : page.items;
  memorySearch = { ...page, query, type, items: [...new Map(rows.map(row => [row.id, row])).values()].slice(-300) };
  render(); if (!memorySearch?.items.length) feedback(page.hasMore ? '本页没有匹配项，可继续查看。' : '没有匹配的记忆。');
}
$('searchMemories').onclick = () => run(() => findMemories());
$('moreMemories').onclick = () => run(() => findMemories(true));
if (!nativeMode && !/^[a-f0-9]{64}$/.test(nonce)) feedback('请从金宝设置页打开队伍入口。');
else { run(refresh); setInterval(() => { if (!document.hidden) run(refresh); }, 3000); }
