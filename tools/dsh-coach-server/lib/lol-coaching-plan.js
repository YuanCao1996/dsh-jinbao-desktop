// Phase policy is independent of the Agent transport. Polls only wake the Agent
// for a milestone or a material change; dispatch rebuilds facts from live memory.
import {isCompletedItem} from '../../lol-companion/item-policy.mjs';
const list = value => Array.isArray(value) ? value : [];
const names = value => list(value).map(x => typeof x === 'string' ? x : x?.name ?? x?.champion ?? x?.id).filter(Boolean);
const fingerprint = value => JSON.stringify(value);

export function stateCoachingTrigger(event, store) {
  if (!store) return null;
  const s = event.state ?? event;
  const time = Number(s.time);
  if (!Number.isFinite(time) || time < 0) return null;
  const level = Number(s.level);
  const ownCompleted=list(s.items).filter(isCompletedItem),enemyCompleted=list(s.enemyItems).filter(isCompletedItem);
  const old = store.coachingSnapshot;
  const material = fingerprint([names(ownCompleted).sort(), names(enemyCompleted).sort(), s.dead,
    s.teamfight?.phase, s.teamfight?.engage, s.championAugments]);
  const reset = !old || time < old.time;
  const reachedSix = level >= 6 && (reset || !old.reachedSix);
  const enemy = fingerprint([names(enemyCompleted).sort(), list(s.championAugments).filter(p => p.side === 'enemy')]);
  const ownItems = fingerprint(names(ownCompleted).sort());
  const died = !reset && s.dead === true && old.dead === false;
  const shopOpened = !reset && s.canShop === true && old.canShop !== true;
  const enemyChanged = !reset && enemy !== old.spokenEnemy;
  let reason = null;
  if (reset) reason = level >= 6 ? 'ultimate' : 'opening';
  else if (died) reason = 'death';
  else if (shopOpened) reason = 'purchase';
  else if (reachedSix) reason = 'ultimate';
  else if (enemyChanged && time - old.spokenAt >= 30) reason = 'enemyChange';
  else if (s.dead === true && ownItems !== old.spokenItems && time - old.spokenAt >= 15) reason = 'purchase';
  else if (material !== old.spokenMaterial && time - old.spokenAt >= 75) reason = 'situation';
  event.coachChanges = reason ? {died,shopOpened,enemyChanged,previousEnemy:old?.spokenEnemy ?? null,currentEnemy:enemy,
    ownItemsChanged:!reset && ownItems !== old.spokenItems} : null;
  store.coachingSnapshot = { time, reachedSix: reachedSix || (!reset && old.reachedSix),
    dead:typeof s.dead === 'boolean' ? s.dead : old?.dead,canShop:s.canShop,
    spokenEnemy:reason ? enemy : old.spokenEnemy,spokenItems:reason ? ownItems : old.spokenItems,
    spokenMaterial: reason ? material : old.spokenMaterial,
    spokenAt: reason ? time : old.spokenAt };
  return reason;
}

const TASKS = {
  death: '刚刚阵亡，利用等待复活时间给两条调整：下次可购买时优先补哪件装备/组件，复活后下一波配合谁、避开什么威胁。结合当前金币、装备、全部已选强化和敌方变化；缺少死亡过程证据不要编造死因或责怪操作。没有商店权限事实时不要断言现在可以买。',
  purchase: '购买决策窗口：根据现有金币、已拥有装备、全部强化、敌方装备，推荐本次优先一件装备或组件，并说明针对谁、为什么。先查本模式价格和可购规则；不知道价格不要断言买得起。已买的不再重复推荐；canShop未确认则使用“下次可购买时”。',
  enemyChange: '对面装备或强化发生变化：指出新增/变化的具体装备或强化、属于哪位英雄，以及它影响自己的哪种打法。只选择确实会改变决策的威胁，给改目标、进场顺序或出装调整之一；变化不关键就静默。不把装备消失或缺失识别说成新增，不知道归属就明确未知。',
  selection: '从我当前英雄和实际可换的备选席中推荐首选与一个备选。结合本模式英雄胜率/强度和队友阵容缺口（前排、开团、清线、伤害类型），说明换或不换的原因；推荐两项本模式可用的召唤师技能及使用目的。不要推荐不在备选席的英雄；敌方未显示就不要猜对手。',
  loading: '用双方已知英雄点名说明这局的优势、最大威胁和取胜条件；英雄样本胜率不是本局获胜概率。给出适合自己英雄的出门装备及理由，再给6级前的消耗/清线/站位与配合方案。加载页不知道实际等级，不要宣称所有人都没大招。',
  opening: '给当前英雄的出门/下一购买窗口装备建议，并围绕双方阵容说明6级前先做什么、躲谁的哪个关键技能、配合哪位队友。自己未到6级不代表所有人没有大招；特殊英雄机制先核实。',
  ultimate: '刚进入6级及以后的打法阶段：点名自己大招的用途、配合哪位队友的控制、先后顺序和优先目标；也说明何时留大招反打。等级达到6不证明已学习大招或冷却结束，未知时用“有大招时/等队友控制命中”。不要猜当前技能CD。',
  augment: '只比较当前仍可选的海克斯，优先参考当前英雄适配排名，再结合全部已拥有强化、装备和对面阵容，明确“首选X，因为Y；备选Z”。单槽刷新后旧候选不再可选；解释具体收益或连招变化，不抄效果详情。没有候选就不要编造。',
  postAugment: '强化选择后的打法调整：区分用户确认/日志确证与推断选择，把全部已拥有海克斯一起考虑。按“强化效果：…；打法：…；下一件成装：…”三段简写，说明全部强化的关键协同机制、对面成装带来的调整与下一波操作。已买装备不要重复推荐购买；购买时机未知则说“下次可购买时”。若仅推断则用“如果选了X”并等待确认，效果数值不明时先查证。',
  situation: '只针对本轮新变化给最重要的一条行动：装备成型、存活人数、血量、阵容威胁或推塔窗口。点名相关英雄/装备和行动条件；没有足够新信息就保持静默，不为播报而重复“注意站位、配合队友”。',
  ended: '本局已结束，停止当前操作和购买建议；仅在有明确事件依据时给一条简短复盘。',
};

function hero(p) {
  if (typeof p === 'string') return { champion: p };
  if (!p) return null;
  return Object.fromEntries(['champion','name','tier','winRate','level','items','spells','dead','respawn','hpPct','gold','roles','canShop']
    .filter(key => p[key] != null).map(key => [key, p[key]]));
}

export function buildLolCoachingPlan(events = [], current = null) {
  const latest = kind => [...events].reverse().find(e => e.kind === kind);
  const snapshot = latest('state');
  const s = snapshot?.state ?? snapshot ?? {};
  const roster = latest('loading_roster') ?? latest('load') ?? latest('game_start') ?? latest('champ_select') ?? {};
  const me = current?.me ?? roster.me ?? s;
  const phase = current?.phase ?? '';
  const offer = latest('augment_offer');
  const picked = latest('augment_picked') ?? events.flatMap(e => e.kind === 'chat_events' ? list(e.events) : [])
    .filter(e => e.kind === 'augment_picked_chat' && me.champion && e.champion === me.champion).at(-1);
  const active = Number(current?.gameSeconds ?? s.time ?? 0) > 0 || phase === 'InProgress';
  let stage = 'situation';
  if (current?.ended) stage = 'ended';
  else if (offer && (!current || list(current.offers).length)) stage = 'augment';
  else if ((picked && !['enemy','ally','other'].includes(picked.who) && (!picked.champion || picked.champion === me.champion)) || latest('augment_mutate')) stage = 'postAugment';
  else if (!active && (phase === 'ChampSelect' || latest('champ_select'))) stage = 'selection';
  else if (!active && (latest('load') || latest('loading_roster'))) stage = 'loading';
  else if (events.some(e => e.coachTrigger === 'death') && me.dead === true) stage = 'death';
  else if (events.some(e => e.coachTrigger === 'purchase')) stage = 'purchase';
  else if (events.some(e => e.coachTrigger === 'enemyChange')) stage = 'enemyChange';
  else if (events.some(e => e.coachTrigger === 'ultimate')) stage = 'ultimate';
  else if (latest('game_start') || events.some(e => e.coachTrigger === 'opening')) stage = Number(me.level) >= 6 ? 'ultimate' : 'opening';
  const facts = {
    stage, phase, gameSeconds: current?.gameSeconds ?? s.time ?? null,
    me: hero(me), allies: list(current?.allies ?? roster.allies).map(hero),
    enemies: list(current?.enemies ?? roster.enemies).map(hero),
    ownedAugments: current?.ownedAugments ?? s.teamfight?.pickedAugments ?? [],
    // Round evidence retains confirmed vs inferred selection provenance.
    augmentRounds: list(current?.augmentRounds).slice(-6),
    recentEvents: list(current?.events).slice(-12),
    recentAdvice: list(current?.broadcasts).slice(-3),
    triggeringObservations: events.slice(-8).map(e => ({kind:e.kind, reason:e.coachTrigger, changes:e.coachChanges,text:String(e.text ?? '').slice(0,1200)})),
  };
  if (stage === 'selection') facts.bench = list(current?.bench ?? roster.bench).map(hero);
  if (stage === 'augment') facts.currentOptions = current?.offers ?? offer?.options ?? [];
  if (stage === 'postAugment') facts.selectionEvidence = picked ?? latest('augment_mutate');
  return { stage, facts, prompt: [
    '【本轮阶段任务】' + TASKS[stage],
    '【本轮筛选事实 JSON】' + JSON.stringify(facts),
    '优先执行本轮阶段任务，不沿用历史阶段。输出2—4条短句，总计80—180字；紧急局势仅1—2句。先结论再具体依据，每句对应本局英雄、强化、装备或事件。不复述面板，不输出泛泛口号，不显示玩家名。',
    '事实与资料分开：缺少决定结论的英雄技能、强化效果、装备或胜率资料时，使用现有DSH资料查询/联网工具，限定本局模式与版本；查不到就明确缺口，不编造数据。大招、金钱、装备和候选以最新事实为准。历史建议不是事实；不重复最近已播报且没有变化的建议。',
  ].join('\n') };
}

const canonical = value => fingerprint(names(value).sort());
function dependencies(current, stage) {
  if(current.game==='generic')return {windowTitle:current.me?.genericState?.windowTitle};
  const me = current.me ?? {};
  // A build component or another player's potion cannot invalidate how an
  // already-confirmed augment works. Revoke only facts this task depends on.
  const identity = {champion:me.champion,owned:canonical(current.ownedAugments)};
  if(stage==='postAugment')return identity;
  if(stage==='augment')return {...identity,offers:canonical(current.offers)};
  if(stage==='ultimate')return {...identity,levelBand:Number(me.level)>=6?'ultimate':'early'};
  const common = {champion:me.champion,phase:current.phase,levelBand:Number(me.level)>=6?'ultimate':'early',items:canonical(list(me.items).filter(isCompletedItem)),owned:canonical(current.ownedAugments),dead:me.dead === true};
  if (stage === 'augment') return {...common,offers:canonical(current.offers)};
  if (stage === 'selection') return {champion:me.champion,phase:current.phase,bench:canonical(current.bench),allies:canonical(current.allies)};
  return {...common,enemy: fingerprint(list(current.enemies).map(p=>[p.champion,canonical(list(p.items).filter(isCompletedItem))])),
    enemyAugments:fingerprint(list(me.championAugments).filter(p=>p.side==='enemy')),canShop:me.canShop};
}

export function createAdviceValidity(stage, current, now = Date.now()) {
  if (!current) return null;
  return {version:1,match:current.match,stage,createdAt:now,expiresAt:now+(['death','purchase','enemyChange','situation'].includes(stage)?45000:90000),
    dependencies:dependencies(current,stage)};
}

export function adviceIsValid(validity, current, now = Date.now()) {
  if (!validity) return true; // Older clients and other games keep their playback contract.
  return validity.version === 1 && !current.ended && validity.match === current.match && now < validity.expiresAt &&
    fingerprint(validity.dependencies) === fingerprint(dependencies(current,validity.stage));
}

// A delayed recommendation must not tell the player to pick a rerolled option.
export function coachingStillCurrent(events, current) {
  if (!current) return true;
  if (events.some(e=>e.coachTrigger==='death') && current.me?.dead !== true) return false;
  const offer = [...events].reverse().find(e => e.kind === 'augment_offer');
  if (offer && fingerprint(names(offer.options).sort()) !== fingerprint(names(current.offers).sort())) return false;
  if (events.some(e => e.kind === 'champ_select') && current.phase && current.phase !== 'ChampSelect') return false;
  return !current.ended;
}
