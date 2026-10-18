import { mkdir, readdir, stat, open, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { WZRY_ADAPTER } from '../dsh-coach-server/lib/adapters/wzry.js';
import { projectWzryFacts } from '../dsh-coach-server/lib/adapters/wzry-facts.js';
import { createMatchTracker } from '../dsh-coach-server/lib/match-tracker.js';
import { rankedAugments, augmentLine, offerNames } from './augment-ranking.mjs';
import { projectProgressEvent,observeEquipment } from './progress-events.mjs';
import { createGameMemory } from '../dsh-coach-server/lib/game-memory.js';
import { normalizeLolMode } from '../dsh-coach-server/lib/game-mode-prompt.js';
import {trackAugmentRound,updateAugmentRecommendations,createEquipmentCoach} from './equipment-context.mjs';

const text = value => typeof value === 'string' ? value.slice(0, 4000) : '';
const list = value => Array.isArray(value) ? value : [];
const keyEventLabels = {
  GameStart:'对局开始',GameEnd:'对局结束',Ace:'团灭',TurretKilled:'防御塔被摧毁',
  InhibKilled:'水晶被摧毁',InhibRespawningSoon:'水晶即将重生',InhibRespawned:'水晶已重生',
  DragonKill:'小龙被击败',BaronKill:'大龙被击败',HeraldKill:'峡谷先锋被击败',
};
export function clock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '等待对局';
  const n = Math.floor(seconds);
  return String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
}
export function initialOverlayState() {
  return { game: null, mode: '', match: null, at: 0, matchStartedAt: 0, gameSeconds: null, ended: false, phase: '',
    me: {}, allies: [], enemies: [], bench: [], playerStats: [], enemyItems: [], events: [], equipmentSnapshots:new Map(),
    ownedAugments: [], augmentRounds: [], offers: [], offerRound: null, offerHistory: [], augmentCaptureAvailable: null, augmentCaptureReason: '', equipment: '', equipmentAssumptions: [], augmentAdvice: '', teamfight: '', broadcasts: [], chat: [] };
}
// Pure projection shared by live polling and log replay tests. Epoch time only orders
// records; the displayed clock always comes from the game's elapsed seconds.
export function applyOverlayEvent(state, event, file) {
  if (!event || typeof event !== 'object') return;
  const at = eventTimestamp(event);
  if (event.broadcast) {
    if(at<state.matchStartedAt||(event.game&&state.game&&event.game!==state.game)||(event.match&&event.match!==state.match))return;
    const reply = { at, text: text(event.broadcast) };
    if (!state.broadcasts.some(r => r.at === at && r.text === reply.text)) {
      state.broadcasts.push(reply); state.broadcasts.sort((a, b) => a.at - b.at);
      state.broadcasts = state.broadcasts.slice(-12);
    }
    return;
  }
  if (!event.game || at < state.at) return;
  const match = event.match ?? file;
  if (event.kind === 'game_start' || event.kind === 'match_start' || (event.kind === 'state' && state.match !== match)) {
    Object.assign(state, initialOverlayState(), { match, matchStartedAt:at, game: event.game });
  }
  state.at = at;
  state.game = event.game;
  if(event.kind==='champ_select'){
    if(state.match!==match||state.phase!=='ChampSelect')Object.assign(state,initialOverlayState(),{match,matchStartedAt:at,game:event.game,at});
    state.phase='ChampSelect';state.me=event.me??{};state.allies=list(event.allies);state.enemies=list(event.enemies);state.bench=list(event.bench);state.gameSeconds=null;
  }
  const mode=normalizeLolMode(event.mode??event.queue??event.state?.mode);
  if(state.game==='lol'&&mode)state.mode=mode;
  if(event.kind==='champ_select_end'){
    state.ended=true;state.phase=event.cancelled?'Lobby':'Loading';
    if(event.cancelled){state.me={};state.allies=[];state.enemies=[];state.bench=[];}
  }
  if (event.kind === 'phase') { state.phase = text(event.phase); if(event.phase==='EndOfGame')state.ended=true; }
  if (event.kind === 'game_start') {
    state.gameSeconds = Number.isFinite(event.gameTime) ? event.gameTime : null;
    state.me = event.me ?? {};
    state.allies = list(event.allies); state.enemies = list(event.enemies);
    observeEquipment(state);
  }
  if (event.kind === 'state') {
    const s = event.state ?? {};
    state.me = { ...state.me, ...event.me, ...s };
    if (Number.isFinite(s.time)) state.gameSeconds = s.time;
    state.allies = Array.isArray(event.allies) ? event.allies : state.allies;
    state.enemies = Array.isArray(event.enemies) ? event.enemies : state.enemies;
    state.enemyItems = list(s.enemyItems);
    state.equipment = text(s.build) || state.equipment;
    state.teamfight = text(s.teamfight?.text) || state.teamfight;
    observeEquipment(state);
  }
  if (event.kind === 'player_stats') state.playerStats = list(event.rows);
  if (event.kind === 'augment_offer') {
    if((event.roll!=null&&event.roll!==state.offerRound)||!state.offers.length)state.offerHistory=[];
    state.offerRound=event.roll??state.offerRound;
    state.offers=list(event.options??event.cards??event.augments).slice(0,3);
    state.offerHistory=[...new Set([...state.offerHistory,...offerNames(state.offers)])].slice(0,6);
  }
  if (event.kind === 'augment_offer_closed') state.offers=[];
  if (event.kind === 'augment_capture_status') { state.augmentCaptureAvailable=event.available===true; state.augmentCaptureReason=text(event.reason); }
  const previousOwned=[...state.ownedAugments];
  projectProgressEvent(state,event);
  trackAugmentRound(state,event,previousOwned);
  if (event.kind === 'event') {
    const seconds = Number(event.time ?? event.EventTime);
    const name = event.name ?? event.EventName;
    if (name === 'GameEnd') state.ended = true;
    const label=Object.hasOwn(keyEventLabels,name)?keyEventLabels[name]:null;
    if(label){
      const id=event.id??event.EventID;
      const key=Number.isInteger(id)?name+':'+id:JSON.stringify([name,seconds,event.turret??event.TurretKilled,event.InhibKilled??event.InhibitorKilled]);
      if(!state.events.some(e=>e.key===key)){
        const result=name==='GameEnd'?(event.Result==='Win'?'胜利':event.Result==='Lose'?'失败':null):null;
        state.events.push({key,time:clock(seconds),text:label+(result?' · '+result:'')});
        state.events=state.events.slice(-40);
      }
    }
  }
  if (event.kind === 'brief' && event.text) {
    const m = event.text.match(/(\d{1,3}):(\d{2})/);
    if (m) state.gameSeconds = Number(m[1]) * 60 + Number(m[2]);
  }
}
export function eventTimestamp(event) {
  return Number(event.t) || Number(event.at) || Date.parse(event.at) || Date.parse(event.timestamp) || 0;
}

export function createOverlayRouter(limit = 64) {
  const states = new Map(), tracker = createMatchTracker(limit);
  let active = initialOverlayState();
  return {
    state: () => active,
    apply(raw, file) {
      if(raw?.clockPending)return;
      let event = raw;
      if(raw?.game==='wzry'&&typeof raw.message==='string') {
        const facts=projectWzryFacts(WZRY_ADAPTER.log.classify(raw));
        if(!facts)return;
        event={...raw,...facts,t:eventTimestamp(raw)};
      }
      if(!event||typeof event!=='object')return;
      if(event.matchEnded&&!(event.kind==='event'&&event.name==='GameEnd'))return;
      if(event.broadcast){
        const requested=typeof event.match==='string'?event.match.replace(/^file-/,''):null;
        const legacy=event.match?.startsWith('file-')?[...states.values()].find(state=>state.game===event.game&&state.match?.endsWith('#1')&&state.source?.replace(/\.jsonl$/i,'')===requested):null;
        const target=requested?states.get(event.game+':'+requested)??legacy:event.source
          ? [...states.values()].filter(state=>state.game===event.game&&state.source===event.source).at(-1)
          : active;
        if(target)applyOverlayEvent(target,{...event,...(requested?{match:target.match}:{})},file);
        return target;
      }
      if(!['lol','wzry'].includes(event.game))return;
      const at=eventTimestamp(event);
      const identity=tracker.identify(event.game,file,{seconds:event.state?.time??event.gameTime,at,
        started:event.kind==='game_start'||event.kind==='match_start',ended:event.kind==='event'&&event.name==='GameEnd',match:event.match});
      if(identity.pending)return;
      const key=event.game+':'+identity.match;
      let state=states.get(key);
      if(!state){
        state=initialOverlayState();
        if(states.size>=limit){const removable=[...states].find(([,candidate])=>candidate!==active);if(removable)states.delete(removable[0]);}
        states.set(key,state);
      }
      applyOverlayEvent(state,{...event,match:identity.match},file);
      state.source=file;
      const isMatch=event.kind==='state'||event.kind==='game_start'||event.kind==='match_start'||event.kind==='champ_select';
      if(isMatch&&(!active.match||active===state||active.ended||
          (at>=active.at&&(event.game===active.game||at-active.at>=30000))))active=state;
      if(active.ended&&event.kind!=='champ_select_end'){
        const next=[...states.values()].filter(candidate=>candidate!==active&&!candidate.ended&&candidate.match&&at-candidate.at<30000)
          .sort((a,b)=>b.at-a.at)[0];
        if(next)active=next;
      }
      return state;
    },
  };
}
const percent = v => Number.isFinite(Number(v)) && v !== null ? Number(v) + '%' : '暂无数据';
function items(value) {
  if (typeof value === 'string') {
    try { return items(JSON.parse(value)); } catch { return value.slice(0, 700); }
  }
  return list(value).map(i => typeof i === 'string' ? i : i?.name ?? i?.champion ?? '').filter(Boolean).join('、');
}
const normalizeHero=value=>String(value??'').replace(/[\s·・]/g,'').toLowerCase();
function heroStatMatches(row,champion){
 const target=normalizeHero(champion);
 return !!target&&[row.name,row.title,row.champion].some(value=>{const hero=normalizeHero(value);return !!hero&&(hero===target||target.includes(hero));});
}
const tierText=value=>value!==null&&value!==undefined&&/^(?:T)?\d+$/i.test(String(value).trim())?'T'+String(value).trim().replace(/^T/i,''):'暂无';
const rosterChampions=state=>[...new Set([state.me.champion,...state.allies.map(p=>p.champion),...state.enemies.map(p=>p.champion),...state.bench.map(p=>p.champion)].filter(v=>typeof v==='string'&&v.trim()))].slice(0,state.phase==='ChampSelect'?30:11);
export function overlayView(state, knowledge = {}) {
  const me = state.me;
  const rows = knowledge.rows ?? [];
  const hero = rows.find(row => row._viewKind==='hero' && heroStatMatches(row,me.champion));
  const own = items(me.items);
  const players = [...state.allies.map(p => ({ ...p, side: '友' })), ...state.enemies.map(p => ({ ...p, side: '敌' })),...state.bench.map(p=>({...p,side:'备选'}))];
  if(!players.length&&me.champion)players.push({...me,side:'我'});
  const playerRows = players.map(p => {
    const r=rows.find(row=>row._viewKind==='hero'&&heroStatMatches(row,p.champion));
    const rate=r?.winRate!=null&&r.winRate!==''?Number(r.winRate):NaN;
    const winRate=Number.isFinite(rate)&&rate>=0&&rate<=100?rate:null;
    return {side:p.side,champion:p.champion||'未知英雄',winRate,
      winRateText:winRate!==null?`${Number(winRate.toFixed(2))}%`:'暂无数据',tierText:tierText(r?.tier)};
  }).sort((a,b)=>(b.winRate??-1)-(a.winRate??-1));
  const roster=playerRows.map(p=>`${p.side} ${p.champion} · ${p.winRateText} · ${p.tierText}`);
  const average=side=>{const team=playerRows.filter(p=>p.side===side);const known=team.filter(p=>p.winRate!==null);return team.length===5&&known.length===5?`${Number((known.reduce((n,p)=>n+p.winRate,0)/5).toFixed(2))}%`:`暂无（${known.length}/5）`;};
  const teamWinRates=state.game==='lol'?`我方平均胜率 ${average('友')} · 敌方平均胜率 ${average('敌')}`:'';
  const builds = rows.filter(r => r._type === 'coreBuilds').map(r => `${items(r.items)}\n  样本胜率 ${percent(r.winRate)} · 使用率 ${percent(r.pickRate)}`);
  const ranked = rankedAugments(rows, me.champion);
  const augments = ranked.slice(0,5).map(augmentLine);
  const offered = offerNames(state.offers);
  const candidates = ranked.filter(row => offered.includes(row.name)).map(augmentLine);
  for(const name of offered)if(!ranked.some(row=>row.name===name))candidates.push(name+' · 暂无该英雄排名');
  const current = state.broadcasts.at(-1)?.text || '等待新的游戏策略建议…';
  const augmentTitle=(offered.length?'当前三选一':'英雄适配海克斯')+' · '+(me.champion||'等待英雄')+(knowledge.loading?' · 刷新中…':'');
  const augmentBody=offered.length ? candidates.join('\n') : augments.join('\n')||knowledge.message||'进入对局后自动检索，或在聊天中咨询。';
  const equipmentUpdates=state.events.filter(e=>e.topic==='equipment').slice(-12).map(e=>`${e.time} ${e.text}`).join('\n');
  const augmentUpdates=state.events.filter(e=>e.topic==='augment-selection').slice(-8).map(e=>`${e.time} ${e.text}`).join('\n');
  const captureHint=state.augmentCaptureAvailable===false
    ? state.augmentCaptureReason==='chinese_language_unavailable'?'系统未安装中文识别语言包，可在 Windows 设置添加简体中文文字识别；日志中的强化信息仍会同步。':'文字识别暂不可用，正在自动重试；日志中的强化信息仍会同步。'
    : state.augmentCaptureReason==='capture_failed'?'游戏画面暂未采集成功，正在自动重试；日志中的强化信息仍会同步。':'等待识别游戏内三选一面板';
  const heroStats = (state.game==='lol'?'大乱斗英雄样本胜率\n':'英雄样本胜率\n') + (hero ? `${hero.name??hero.champion} · ${hero.tier!=null?tierText(hero.tier):''} · ${percent(hero.winRate)}${hero.version ? ' · 版本 ' + hero.version : ''}` : knowledge.message || '等待英雄知识检索');
  return {
    game: state.game, match: state.match, gameTime: clock(state.gameSeconds), phase:state.phase, ended: state.ended,
    title: '金宝 · ' + (state.game === 'lol' ? '英雄联盟' : state.game === 'wzry' ? '王者荣耀' : '游戏教练'),
    summary: [me.champion, me.level != null ? 'Lv' + me.level : '', me.k != null ? `${me.k}/${me.d ?? 0}/${me.a ?? 0}` : '', me.gold != null ? '金币 ' + me.gold : ''].filter(Boolean).join(' · '),
    advice: ['对局 '+clock(state.gameSeconds),me.champion,me.level!=null?'Lv'+me.level:'',me.k!=null?`${me.k}/${me.d??0}/${me.a??0}`:'',me.gold!=null?'金币 '+me.gold:''].filter(Boolean).join(' · ')+'\n\n'+current+(state.game==='lol'&&offered.length?'\n\n海克斯推荐 · 当前三选一\n'+candidates.join('\n'):'')+(state.game==='lol'&&state.ownedAugments.length?'\n\n本局已选海克斯\n'+state.ownedAugments.join('、'):''),
    equipment: '当前装备\n' + (own || '等待装备日志') + '\n\n推荐出装\n' + (state.equipment || builds.join('\n\n') || knowledge.message || '进入对局后自动检索并结合装备与海克斯更新建议。')+(state.equipmentAssumptions.length?'\n\n待确认的强化推测\n'+state.equipmentAssumptions.map(a=>`第${a.round}轮暂按 ${a.name} 考虑`).join('\n'):'')+(equipmentUpdates?'\n\n装备动态\n'+equipmentUpdates:''),
    augments: state.game==='wzry'?'王者荣耀常规对局没有海克斯强化。可在装备页查看建议，或通过聊天咨询当前局势。':
      augmentTitle+'\n按该英雄适配排名排序\n'+augmentBody+
      (offered.length?'\n\n本轮已见 '+state.offerHistory.length+'/6':'\n\n'+captureHint)+'\n\n本局已选\n'+(state.ownedAugments.join('、')||'尚未收到强化选择日志')+(augmentUpdates?'\n\n强化动态\n'+augmentUpdates:''),
    players: (teamWinRates?teamWinRates+'\n五名英雄样本胜率的算术平均，非本局预测\n\n':'')+heroStats+'\n\n双方英雄胜率（按胜率从高到低）\n'+(roster.join('\n\n') || '等待双方英雄数据。'),
    teamWinRates,
    heroStats,
    playerRows,
    stats: heroStats+'\n\n'+roster.join('\n'),
    teamfight: state.teamfight || '可在聊天中询问本局团战打法；建议会结合双方阵容和当前装备。',
    events: state.events.map(e => `${e.time} ${e.text}`).join('\n') || '等待关键事件：装备购买、海克斯选择、团灭和重要目标。',
    chat: state.chat.map(r => `${r.role === 'user' ? '我' : '教练'}：${r.text}`).join('\n\n') || '输入问题，与教练讨论当前对局。',
    chatRows: state.chat.slice(-12).map(r => ({role:r.role,origin:r.origin??'',text:r.text})),
    status: knowledge.loading ? '正在检索推荐…' : '', updatedAt: state.at,
  };
}

export async function createOverlayService({ stateDir, agentChat, search, pollMs = 1000, equipmentDebounceMs=2000, equipmentCooldownMs=30000 }) {
  const logs = join(stateDir, 'logs'), output = join(stateDir, 'overlay-state.json');
  await mkdir(logs, { recursive: true });
  const router=createOverlayRouter(), offsets = new Map();
  const memory = createGameMemory(stateDir);
  let state=router.state();
  let restoredChat;
  try{const saved=JSON.parse(await readFile(join(stateDir,'overlay-chat.json'),'utf8'));if(saved&&Array.isArray(saved.chat))restoredChat=saved;}catch{}
  let knowledge = {}, knowledgeKey = '', refreshTask = null, refreshQueued = false, scanning = false, closed = false, busy = false;
  let forceRefresh = false, cached = { key: '', rows: [], candidates: new Map(), heroes: new Map() };
  const contextKey = () => state.game+':'+state.match+':'+state.matchStartedAt+':'+state.me.champion+':'+JSON.stringify([offerNames(state.offers).sort(),[...state.ownedAugments].sort(),rosterChampions(state).sort()]);
  async function save() {
    if (closed) return;
    await writeFile(output + '.tmp', JSON.stringify(overlayView(state, knowledge)), { mode: 0o600 });
    await rename(output + '.tmp', output);
    await writeFile(join(stateDir,'overlay-chat.json'),JSON.stringify({game:state.game,match:state.match,matchStartedAt:state.matchStartedAt,chat:state.chat}),{mode:0o600});
    await memory.snapshot(state, knowledge.rows ?? []);
  }
  // Serialize disk snapshots: model requests and polling may finish concurrently.
  let writes = Promise.resolve();
  const flush = () => (writes = writes.catch(() => {}).then(save));
  const equipmentCoach=createEquipmentCoach({getState:()=>state,agentChat,save:flush,debounceMs:equipmentDebounceMs,cooldownMs:equipmentCooldownMs});
  function refresh(force = true) {
    if(closed)return Promise.resolve();
    forceRefresh ||= force;
    if(refreshTask){refreshQueued=true;return refreshTask;}
    refreshTask=(async()=>{do{refreshQueued=false;await performRefresh();}while(refreshQueued&&!closed);})().finally(()=>{refreshTask=null;});
    return refreshTask;
  }
  async function performRefresh() {
    const selecting=state.phase==='ChampSelect';
    const champion = state.me.champion||(selecting?rosterChampions(state)[0]:null);
    const game = state.game;
    if (!champion) throw Object.assign(Error('请先进入对局'), { status: 409 });
    const key = contextKey();
    const baseKey = game+':'+state.match+':'+state.matchStartedAt+':'+(state.phase==='ChampSelect'?'selection':champion);
    const force = forceRefresh; forceRefresh = false;
    if(cached.key!==baseKey)cached={key:baseKey,rows:[],candidates:new Map(),heroes:new Map()};
    const cache = cached;
    const stillCurrent = () => !closed && key === contextKey();
    knowledge = { ...knowledge, loading: true }; await flush();
    try {
      const offered = offerNames(state.offers).slice(0,3);
      const base = async () => {
        if(selecting||(!force&&cache.rows.length))return;
        const results=await Promise.all(game==='wzry'?[search({game,query:champion,limit:3})]:[
          search({game,query:champion,filter:{_type:'coreBuilds'},limit:3}),
          search({game,query:champion,filter:{_type:'augments'},limit:5}),
        ]);
        cache.rows=results.flatMap(r=>(r.results??[]).map(item=>item.data));
      };
      await Promise.all([base(),...rosterChampions(state).filter(name=>game==='lol'&&(force||!cache.heroes.has(name))).map(async name=>{
        try{
          const result=await search({game,query:name,dataset:'aram-ranking',limit:1});
          cache.heroes.set(name,(result.results??[]).map(item=>({...item.data,_viewKind:'hero'})).filter(row=>heroStatMatches(row,name)));
        }catch{if(!cache.heroes.has(name))cache.heroes.set(name,[]);}
      }),...offered.filter(name=>game==='lol'&&(force||!cache.candidates.has(name))).map(async name=>{
        const result=await search({game,query:champion,filter:{_type:'augments',name},limit:1});
        cache.candidates.set(name,(result.results??[]).map(item=>item.data));
        if(cache.candidates.size>100)cache.candidates.delete(cache.candidates.keys().next().value);
      })]);
      if (stillCurrent()) knowledge = { rows: [...offered.flatMap(name=>cache.candidates.get(name)??[]),...cache.rows,...[...cache.heroes.values()].flat()].filter(row => row?._viewKind==='hero'|| (typeof row?.champion === 'string' && row.champion.includes(champion))||row?.name===champion||row?.title===champion), message: '未查到匹配记录，可在聊天中咨询。' };
    } catch (e) {
      if(stillCurrent())knowledge = { message: e.status === 401 || e.status === 403 ? '请在设置页登录并开通攻略检索权限；自带模型密钥与检索权限独立。' : '推荐检索暂时不可用，可在聊天中咨询。' };
    } finally {
      updateAugmentRecommendations(state,knowledge.rows??[]);
      await flush();
      if(!stillCurrent()&&state.me.champion&&Date.now()-state.at<30000)void refresh(false).catch(()=>{});
    }
  }
  async function scan() {
    if (scanning || closed) return;
    scanning = true;
    try {
      const pending = [];
      for (const file of (await readdir(logs)).filter(f => f.endsWith('.jsonl') && !f.includes('overlay-chat'))) {
        const path = join(logs, file), info = await stat(path);
        let offset = offsets.get(file) ?? 0;
        const first = !offsets.has(file);
        if (info.size < offset) offset = 0;
        if (info.size <= offset) continue;
        const f = await open(path, 'r');
        try {
          const data = Buffer.alloc(Math.min(info.size - offset, 1024 * 1024));
          const { bytesRead } = await f.read(data, 0, data.length, offset);
          const buffer = data.subarray(0, bytesRead), end = buffer.lastIndexOf(10);
          if (end < 0) continue;
          const lines = buffer.subarray(0, end).toString('utf8').split('\n');
          if (first && offset > 0) lines.shift();
          let position = offset;
          for (const line of lines) {
            position += Buffer.byteLength(line, 'utf8') + 1;
            try { pending.push({ event: JSON.parse(line), file, position: { key: file + ':' + info.birthtimeMs, offset: position } }); } catch {}
          }
          offsets.set(file, offset + end + 1);
        } finally { await f.close(); }
      }
      pending.sort((a, b) => eventTimestamp(a.event)-eventTimestamp(b.event));
      const observedStates = new Set();
      for (const { event, file, position } of pending) {
        updateAugmentRecommendations(state,knowledge.rows??[]);
        const observed = router.apply(event,file);
        if (observed) { await memory.record(observed,event,file,position); observedStates.add(observed); }
      }
      for (const observed of observedStates) await memory.snapshot(observed);
      await memory.flush();
      state=router.state();
      if(state.match&&restoredChat){
        if(restoredChat.game===state.game&&restoredChat.match===state.match&&restoredChat.matchStartedAt===state.matchStartedAt){
          state.chat=restoredChat.chat.slice(-20);restoredChat=null;
        }
      }
      try {
        const coach = JSON.parse(await readFile(join(stateDir, 'coach_live_state.json'), 'utf8'));
        if (coach.lastReply?.text&&coach.lastReply.match)router.apply({...coach.lastReply,broadcast:coach.lastReply.text},'coach');
      } catch {}
      const key = contextKey();
      if(key!==knowledgeKey){
        knowledgeKey=key;knowledge={};
        if((state.me.champion||(state.phase==='ChampSelect'&&rosterChampions(state).length))&&!state.ended&&Date.now()-state.at<30000)void refresh(false).catch(()=>{});
      }
      await flush();
      equipmentCoach.tick();
    } catch {} finally { scanning = false; }
  }
  await scan();
  const timer = setInterval(scan, pollMs); timer.unref();
  return {
    view: () => overlayView(state, knowledge), refresh,
    async ask(question, topic, metadata = {}) {
      if (busy) throw Object.assign(Error('教练正在回复'), { status: 409 });
      if (typeof question !== 'string' || !question.trim() || question.length > 1000) throw Object.assign(Error('问题格式不正确'), { status: 400 });
      busy = true;
      const match = state.match, started = state.matchStartedAt;
      const stillCurrent = () => state.match === match && state.matchStartedAt === started;
      const q = { role: 'user', text: question.trim(), origin: metadata.origin === 'phone' ? 'phone' : 'desktop' }; state.chat.push(q);
      state.chat = state.chat.slice(-20);
      try {
        await memory.record(state, { kind: 'chat', ...q, gameSeconds: state.gameSeconds }, 'overlay-chat');
        await flush();
        if (!agentChat) throw Object.assign(Error('DSH Agent 聊天接口尚未就绪，请重新打开金宝'), { status: 503 });
        const answer = await agentChat({ game: state.game || 'lol', match: state.match || 'waiting', question: q.text, topic });
        if(!stillCurrent())throw Object.assign(Error('对局已切换，请在当前对局重新提问'),{status:409});
        state.chat.push({ role: 'assistant', text: text(answer) });
        await memory.record(state, { kind: 'chat', role: 'assistant', text: text(answer), gameSeconds: state.gameSeconds }, 'overlay-chat');
        if(topic==='teamfight')state.teamfight=text(answer);
        if(topic==='equipment')state.equipment=text(answer);
        if(topic==='augments')state.augmentAdvice=text(answer);
        return { answer: text(answer) };
      } catch (e) {
        if(stillCurrent())state.chat.push({ role: 'assistant', text: e.status === 401 ? '请在设置页保存可用的模型配置后重试。' : e.status === 503 ? 'DSH Agent 尚未就绪，请重新打开金宝后重试。' : '这次回复失败，请稍后重试。' });
        throw e;
      } finally { busy = false; await flush(); }
    },
    async close() { closed = true; equipmentCoach.close(); clearInterval(timer); await writes.catch(() => {}); await memory.flush(); },
  };
}
