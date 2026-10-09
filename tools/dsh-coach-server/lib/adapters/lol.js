// adapters/lol.js — 英雄联盟(端游)adapter
// ----------
// 与 wzry.js 同一契约,但游戏侧知识完全不同:
//   · wzry 的数据来自手机 adb logcat(正则提取 + OCR);
//   · LoL 端游的数据来自**本机三个只读通道**,由 tools/lol-companion 归一化成 jsonl:
//       1) LCU API(lockfile → 127.0.0.1:<port>)  选人界面 / 对局阶段 / 模式
//       2) Live Client Data API(127.0.0.1:2999)  局内等级/金币/KDA/装备/事件
//       3) 本地 PP-OCRv6(127.0.0.1:3099)         API 拿不到的 UI 文本(海克斯三选一等)
//     因此这份 adapter 是"纯格式化 + 分级":事实的采集与本地数据(胜率/强化)的
//     关联在 companion 侧完成,adapter 只把它们变成模型可读的观察文本。
//
// 事件类型(companion 写入 jsonl 的 kind):
//   phase / champ_select / load / augment_offer / augment_picked / game_start
//   state / event / ocr / interaction
//
// 首期目标模式:海克斯大乱斗(ARAM + 海克斯强化)。三段关键时机:
//   选人界面 → 英雄强度/胜率;加载页 → 对局建议;开局 → 海克斯选择 + 前期出装。

//#region 配置
const PERSONA_SYSTEM_PROMPT =
  "你是英雄联盟端游助手金宝,当前主玩海克斯大乱斗(极地大乱斗 + 海克斯强化)。" +
  "你熟悉极地大乱斗的地图节奏(单线、无回城补给、雪球/治疗包、回复削弱、团战频繁),也熟悉海克斯强化的取舍逻辑。" +
  // 这个模式里**有两种三选一**,必须让模型分清,否则会把属性碎片当强化讨论
  "注意这个模式里有两种三选一:①【海克斯选择】给的是强化效果(金/棱彩档);" +
  "②【属性碎片选择】来自属性锻造器,给的是纯属性(攻击力/攻速/法术穿透等),不是强化。" +
  "两者取舍逻辑不同:强化的价值看效果与阵容配合,属性碎片看你的英雄更需要哪种属性。" +
  // 团战打法:事实层由本地算出(定位/出装/阶段都来自真实数据),
  // 模型负责把它讲成"现在这一波该怎么打" —— 技能细节是模型自己的知识。
  "【团战打法】观察里若带【团战·前/中/后期】段落,里面是本地按**英雄定位(DataDragon roles)、" +
  "双方出装(Live API)、当前等级与装备件数**算出的事实:谁能开团、主要打谁、先别管谁、你的站位、进场时机。" +
  "你要基于这些事实,结合该英雄的**技能机制**(你的知识)给出这一波具体怎么打:" +
  "先手还是后手、谁去开、盯着谁打、技能先交什么留什么、什么时候进场、打不过该怎么退。" +
  "定位与出装是确定的;若标注了「从画面推断,不确证」,说明那是猜的,不要当事实讲。" +
  "给建议时先给结论再给一句依据,基于阵容与当前局势,不要空泛的正确废话。";

/** 高信号:出现这些说明是真实战局转折,不受低信号限流约束,立即触发。 */
const HIGH_SIGNAL_RE = /大龙|男爵|远古巨龙|巨龙|小龙|先锋|峡谷先锋|防御塔|水晶|基地|团灭|一血|五杀|四杀|三杀|双杀|被击杀|击杀|抢龙|反打|ace/i;
/**
 * 局内事件里"值得立即打断"的。
 * 与 HIGH_SIGNAL_RE 不同:后者用于普通 event(逐条本来就少),
 * 这里是一批几十条击杀的摘要,必须收得更紧,否则每 5 秒就触发一次对话。
 * 只认:多杀及以上 / 团灭 / 超神 / 大龙小龙 / 终结连杀。
 */
const HIGH_SIGNAL_CHAT_RE = /三杀|四杀|五杀|团灭|超神|大龙|男爵|远古巨龙|已终结了[^。]{0,30}(?:连杀|超神)|抢龙|ace/i;

/** 噪音:客户端界面文字,不是战况。 */
const NOISE_RE =
  /^[\s\d%:：.\-+×xX]*$|正在加载|正在连接|重连|游戏结束|再来一局|继续|返回大厅|商城|藏品|战利品|任务|活动|设置|退出|排位|匹配|秒|延迟|帧率|FPS|Ping|已就绪|确认|接受|拒绝|禁用|英雄选择|锁定|皮肤|表情|符文|召唤师技能|天赋|推荐出装|商店/i;
// ⚠ 这里**不能**再放「记分板」:它原先是"对局中按 Tab 的整屏 OCR 噪音",
//   但记分板现在是**一等数据源**(§8.11 起,scoreboard 事件带双方十人金币)。
//   留着它会让每一个 scoreboard 事件被 isRelevant 判为噪音而**静默丢弃** ——
//   真机复现:一局抓到 3 个 scoreboard,全部 isRelevant=false,教练一条都没看到。
//   教训:NOISE_RE 是"某类文本曾经没用",一旦这类文本变成数据源,必须同步移出。
//
// ⚠ 更根本的一条:这条正则只该作用于**屏幕上抄来的文字**(ocr 事件)。
//   结构化事件的正文是我们自己按字段拼的,里面出现「符文」只可能是业务解释,
//   不是界面噪音 —— 详见 STRUCTURED_KINDS。历史上同一个坑踩过两次
//   (记分板、加载页阵容),所以这次把它变成规则而不是逐条打补丁。

/** OCR 面板来源 → 中文标签(海克斯三选一是首要目标)。 */
const OCR_SOURCE_LABEL = {
  augment_panel: "海克斯选择面板",
  loading_screen: "加载页",
  scoreboard: "记分板",
  shop: "商店",
  unknown: "屏幕",
};

/** 事件名 → 中文(给模型看的战况词;未收录则原样保留英文)。 */
const EVENT_CN = {
  ChampionKill: "击杀",
  Multikill: "多杀",
  Ace: "团灭",
  FirstBlood: "一血",
  TurretKilled: "防御塔被推",
  InhibKilled: "水晶被推",
  InhibRespawningSoon: "水晶即将重生",
  DragonKill: "击杀小龙",
  BaronKill: "击杀大龙",
  HeraldKill: "击杀峡谷先锋",
  GameStart: "游戏开始",
  MinionsSpawning: "小兵出发",
  FirstBrick: "首座防御塔",
  GameEnd: "对局结束",
};

/** 强化档位 → 中文稀有度。 */
const TIER_CN = { kSilver: "银", kGold: "金", kPrismatic: "棱彩", kEventChoice: "事件", 1: "银", 2: "金", 3: "棱彩" };

/** 对局阶段变化里值得播报的(避免 Lobby/Matchmaking 等噪声触发)。 */
const PHASE_WORTHY = new Set(["ChampSelect", "GameStart", "InProgress", "Reconnect", "WaitingForStats", "EndOfGame", "PreEndOfGame"]);
//#endregion

//#region 工具
const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** 阵容一行:英雄 + 强度信息(companion 已带上 tier/winRate 则一并展示)。 */
function fmtPick(p) {
  if (!p) return "?";
  const name = p.champion || p.name || "?";
  const bits = [];
  if (n(p.tier)) bits.push(`T${p.tier}`);
  if (n(p.winRate)) bits.push(`${p.winRate}%`);
  if (n(p.level)) bits.push(`Lv${p.level}`);
  if (n(p.k)) bits.push(`${p.k}/${p.d ?? 0}/${p.a ?? 0}`);
  if (p.dead) bits.push(`阵亡${n(p.respawn) ? `(${Math.round(p.respawn)}s)` : ""}`);
  return bits.length ? `${name}(${bits.join(" ")})` : name;
}

function fmtTeam(list) {
  if (!Array.isArray(list) || list.length === 0) return "未知";
  return list.map(fmtPick).join("、");
}

function fmtItems(items) {
  if (!Array.isArray(items) || items.length === 0) return "无";
  return items.map((i) => (typeof i === "string" ? i : i?.name ?? `#${i?.id ?? "?"}`)).join("、");
}

/** 秒 → "MM:SS" */
function clock(sec) {
  const s = Math.max(0, Math.round(sec ?? 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
//#endregion

//#region 日志解析(log:原始行 → 规范化事件)
/**
 * companion 写入的 jsonl 一行 → 规范化事件。未知 kind 返回 null(内核忽略)。
 * 每行都带 game:"lol",内核据此选 adapter(多游戏共存的关键)。
 */
function classify(raw) {
  if (!raw || typeof raw !== "object") return null;
  // 允许共存文件里的非本游戏行被跳过
  if (raw.game && String(raw.game).toLowerCase() !== "lol") return null;
  const kind = String(raw.kind ?? "");
  if (!kind) return null;
  switch (kind) {
    case "phase":
      return { kind, key: raw.phase, phase: raw.phase, prev: raw.prev, text: `阶段: ${raw.prev ?? "?"} → ${raw.phase}` };
    case "champ_select":
      return { kind, key: "选人", ...raw, text: champSelectText(raw) };
    case "load":
      return { kind, key: "加载", ...raw, text: loadText(raw) };
    case "augment_offer":
      return { kind, key: "海克斯", ...raw, text: augmentOfferText(raw) };
    case "shard_offer":
      return { kind, key: "属性碎片", ...raw, text: shardOfferText(raw) };
    case "augment_picked":
      return { kind, key: raw.name ?? "海克斯", ...raw, text: `已选海克斯强化: ${raw.name ?? "?"}(${TIER_CN[raw.tier] ?? raw.tier ?? "?"})` };
    case "game_start":
      return { kind, key: "开局", ...raw, text: gameStartText(raw) };
    case "loading_roster":
      // 加载页读出的双方完整阵容。海克斯大乱斗**选人阶段看不到对手**
      // (LCU 的 enemies 实测恒为空),这是"敌方是谁"唯一的第一手来源 ——
      // 不在这里放行,它会被 isRelevant 当噪音静默丢弃,针对性建议就永远出不来。
      return { kind, key: "加载页阵容", ...raw, text: loadingRosterText(raw) };
    case "vision":
      // 画面理解兜底(多模态模型看截图)。本地 OCR 读不全时的补充 ——
      // 同样必须在这里放行,否则会被 isRelevant 当噪音**静默丢弃**,
      // 而它恰恰带着"敌方是谁"以及置信度/不确定项(同一类坑踩过两次:
      // 记分板、加载页阵容,见 NOISE_RE 上方的注释)。
      return { kind, key: "画面识别", ...raw, text: visionText(raw) };
    case "scoreboard":
      return { kind, key: "记分板", ...raw, text: scoreboardText(raw) };
    case "augment_mutate":
      return { kind, key: `质变:${raw.augment ?? "?"}`, ...raw, text: augmentMutateText(raw) };
    case "chat_events":
      return { kind, key: "局内事件", ...raw, text: chatEventsText(raw) };
    case "result_board":
      return { kind, key: "结算", ...raw, text: resultBoardText(raw) };
    case "state":
      return { kind, key: "局势", ...raw, text: stateText(raw) };
    case "event":
      return { kind, key: EVENT_CN[raw.name] ?? raw.name, ...raw, text: eventText(raw) };
    case "ocr": {
      const lines = (raw.lines ?? []).map((l) => (typeof l === "string" ? l : l?.text)).filter(Boolean);
      if (lines.length === 0) return null;
      const label = OCR_SOURCE_LABEL[raw.source] ?? OCR_SOURCE_LABEL.unknown;
      return { kind, key: raw.source ?? "ocr", source: raw.source, lines, wordsWithLoc: raw.wordsWithLoc, text: `[${label}] ${lines.join(" | ")}` };
    }
    case "interaction":
      return { kind, key: raw.key ?? "用户", context: { content: raw.content ?? raw.text ?? "" }, text: raw.content ?? raw.text ?? "" };
    case "player_stats":
      // 双方十人的大乱斗战绩(companion 查 LCU 得到,**一次性**事件)。
      // ⚠ 刻意**不放进 dialogKinds**:它是背景资料,不该自己触发一次教练回合
      //   (那会变成"刚开局就凭空说一句话")。放在这里只是为了让它在事件流里有标签、
      //   在回放里看得到 —— 记分板/加载页阵容当初就是因为没在这里放行,
      //   被 isRelevant 当噪音**静默丢弃**,排查了半天。
      return { kind, key: "双方战绩", ...raw, text: playerStatsText(raw) };
    default:
      return null;
  }
}

/** 双方战绩 → 可读文本。rows 是主数据;enemyLine/table 是给悬浮窗的成品文案。 */
function playerStatsText(raw) {
  const rows = Array.isArray(raw.rows) ? raw.rows : [];
  const head = `【双方大乱斗战绩】${raw.got ?? rows.filter((r) => r.winRate !== null && r.winRate !== undefined).length}/${raw.queried ?? rows.length} 人有记录(近 20 局)`;
  const side = (t, label) => {
    const list = rows.filter((r) => r.team === t);
    if (!list.length) return "";
    return `${label}: ` + list.map((r) => r.winRate === null || r.winRate === undefined
      ? `${r.champion} 无记录`
      : `${r.champion} ${r.winRate}%(${r.games}局 KDA ${r.kda ?? "-"})`).join("; ");
  };
  return [head, side("enemy", "敌方"), side("ally", "我方"), side("me", "我")].filter(Boolean).join("\n");
}

function champSelectText(raw) {
  const head = `【选人界面】模式: ${raw.queue ?? raw.mode ?? "?"}`;
  const me = raw.me ? `我的英雄: ${fmtPick(raw.me)}${raw.me.recommend ? ` — ${raw.me.recommend}` : ""}` : "";
  const allies = `我方: ${fmtTeam(raw.allies)}`;
  const enemies = `敌方: ${raw.enemies?.length ? fmtTeam(raw.enemies) : "（尚未显示）"}`;
  const bench = Array.isArray(raw.bench) && raw.bench.length ? `备选席: ${fmtTeam(raw.bench)}` : "";
  return [head, me, allies, enemies, bench].filter(Boolean).join("\n");
}

function loadText(raw) {
  return [
    `【加载页】模式: ${raw.mode ?? "?"}`,
    raw.me ? `我用: ${fmtPick(raw.me)}` : "",
    `我方: ${fmtTeam(raw.allies)}`,
    `敌方: ${fmtTeam(raw.enemies)}`,
    raw.advice ? `本地建议: ${raw.advice}` : "",
  ].filter(Boolean).join("\n");
}

function augmentOfferText(raw) {
  const opts = (raw.options ?? []).map((o, i) => {
    const tier = TIER_CN[o.tier] ?? o.tier ?? "?";
    const extra = [o.desc, o.fit].filter(Boolean).join("; ");
    return `  ${i + 1}. ${o.name ?? "?"}[${tier}]${extra ? ` — ${extra}` : ""}`;
  });
  return [`【海克斯选择】第${raw.roll ?? 1}次三选一`, opts.join("\n")].join("\n");
}

/**
 * 属性锻造器三选一(海克斯大乱斗里的**第二种**三选一)。
 * 与海克斯强化的区别:给的是**属性碎片**(攻击力/攻速/法穿…),不是强化效果;
 * 卡片边框是银灰,标签统一为「属性锻造器」。实测:一局里会多次出现。
 */
function shardOfferText(raw) {
  const opts = (raw.options ?? []).map((o, i) => {
    const extra = String(o.desc ?? "").replace(/\s+/g, " ").slice(0, 60);
    return `  ${i + 1}. ${o.name ?? "?"}${extra ? ` — ${extra}` : ""}`;
  });
  return [`【属性碎片选择】第${raw.roll ?? 1}次三选一(属性锻造器,给属性而非强化)`, opts.join("\n")].join("\n");
}

function gameStartText(raw) {
  return [
    "【开局】",
    raw.me ? `我用: ${fmtPick(raw.me)}${raw.me.augment ? ` 起始强化: ${raw.me.augment}` : ""}` : "",
    `我方: ${fmtTeam(raw.allies)}`,
    `敌方: ${fmtTeam(raw.enemies)}`,
    raw.build ? `推荐出装: ${raw.build}` : "",
    `初始金币: ${raw.gold ?? 500}`,
  ].filter(Boolean).join("\n");
}

/** 聊天确证的强化质变(局内播报,高置信度)。 */
function augmentMutateText(raw) {
  const tierCn = TIER_CN[raw.tier] ?? raw.tier ?? "";
  return [
    `【强化质变·局内播报确证】${raw.champion ? `${raw.champion} ` : ""}已质变 → ${raw.augment ?? "?"}${tierCn ? `(${tierCn})` : ""}`,
    raw.desc ? `效果: ${raw.desc}` : "",
    // 语义澄清:海斗的质变播报是队友换强化时打出来的,不是"我自己选了"
    "（说明:这是局内播报,通常为队友更换强化;不要再靠面板消失去推断）",
  ].filter(Boolean).join("\n");
}

/**
 * 局内事件摘要(击杀/购买/信号)。
 *
 * 为什么聚合成一条而不是逐条:一局能产生几十条击杀播报,逐条触发会把对话刷爆。
 * 教练需要的是"刚才这段时间发生了什么",所以一次给一批。
 */
function chatEventsText(raw) {
  const evs = raw.events ?? [];
  if (!evs.length) return "";
  const label = { kill: "击杀", purchase: "购买", ping: "信号" };
  const lines = [`【局内事件】最近 ${evs.length} 条`];
  for (const e of evs) {
    // 去掉行首时间戳(已经在 time 字段里),避免「07:08 07:08 xxx」重复
    // ⚠ 正文优先用 `display`(剥过玩家名,只留英雄名)—— 这是项目既有要求
    //   (chat.mjs 的 stripPlayerNames /「聊天只留英雄名」),回放页一路用的就是它。
    //   companion 直到 2026-09-20 才真的把 display 存进 chatEvents;在那之前这里
    //   只能读到带玩家名的原文,与回放页显示的不一样(用户可见的不一致)。
    const src = e.display ?? e.text;
    const body = String(src ?? "").replace(/^\s*\d{1,2}:\d{2}\s*/, "").trim();
    lines.push(`  ${e.time ? `${e.time} ` : ""}[${label[e.kind] ?? e.kind}] ${body}`);
  }
  return lines.join("\n");
}

/**
 * 加载页阵容:海克斯大乱斗选人阶段看不到对手,加载页是**唯一**能读到敌方五人的地方。
 * 这条信息决定后面所有"针对敌方"的出装/符文/打法建议,必须写得让模型一眼能用。
 */
function loadingRosterText(raw) {
  const f = (p) => `${p.champion ?? "?"}${p.title && p.title !== p.champion ? `(${p.title})` : ""}`;
  const allies = (raw.allies ?? []).map(f);
  const enemies = (raw.enemies ?? []).map(f);
  return [
    `【加载页阵容】${raw.mode ? `模式: ${raw.mode}` : ""}`.trim(),
    `我方(${allies.length}): ${allies.join("、") || "?"}`,
    `敌方(${enemies.length}): ${enemies.join("、") || "?"}`,
    "（海克斯大乱斗选人阶段看不到对手,这份名单来自加载页 —— 后续针对敌方的出装/符文/打法都按它来）",
  ].join("\n");
}

/**
 * 画面理解兜底(多模态模型看截图)。
 *
 * 这份结果的**可靠性明显低于本地链路**,所以必须把置信度与不确定项一起写给教练 ——
 * 不写的话,模型看错(实测它会把「双界灵兔」说成亚索)就会变成"确证"进入建议链。
 * 本地已经做的分工:模型只抄字,英雄名与阵营由本地表 + 选人阵容决定。
 */
function visionText(raw) {
  const f = (p) => `${p.champion ?? "?"}${p.title && p.title !== p.champion ? `(${p.title})` : ""}`;
  const L = [`【画面识别(多模态兜底)】触发: ${raw.reason ?? "?"}`];
  // ⚠ 字段名不能叫 `game` —— companion 的每条事件都带 `game`(用于多游戏路由),
  //   那是**游戏 id**(lol/wzry),不是"哪款游戏"的自然语言名。
  //   同名会让这里印出「游戏: lol」(实测踩到),而正确内容是「英雄联盟」。
  if (raw.gameName) L.push(`游戏: ${raw.gameName}`);
  if (raw.screen) L.push(`阶段: ${raw.screen}`);
  if (raw.visionMode) L.push(`模式: ${raw.visionMode}`);
  if (raw.sideKnown) {
    L.push(`我方: ${(raw.allies ?? []).map(f).join("、") || "?"}`);
    L.push(`敌方: ${(raw.enemies ?? []).map(f).join("、") || "?"}`);
    if (raw.sideSource) L.push(`(阵营依据: ${raw.sideSource})`);
  } else if ((raw.allies ?? []).length) {
    L.push(`画面上的英雄(认不出哪边是我方): ${(raw.allies ?? []).map(f).join("、")}`);
  }
  if ((raw.unresolved ?? []).length) L.push(`没认出来的名字: ${raw.unresolved.join("、")}`);
  // 模型抄到的原文也带上 —— 排查时能区分"模型抄错了"还是"本地查表错了"
  if ((raw.rawNames ?? []).length) L.push(`画面抄到的原文: ${raw.rawNames.join("、")}`);
  // ⚠ 置信度与不确定项必须写出来 —— 这是"兜底结果"与"本地确证"的区别所在
  L.push(`识别置信度: ${raw.confidence ?? "?"}` +
    ((raw.uncertain ?? []).length ? ` | 不确定: ${raw.uncertain.join("; ")}` : ""));
  return L.join("\n");
}

/** Tab 记分板:对局中玩家主动按 Tab 时的双方金币/KDA 快照。 */function scoreboardText(raw) {  const rows = (arr, label) => (arr ?? []).map((p, i) =>
    `  ${i + 1}. KDA ${p.kda?.k ?? "?"}/${p.kda?.d ?? "?"}/${p.kda?.a ?? "?"}${p.gold != null ? ` 金币${p.gold}` : ""}`);
  const my = (raw.team ?? []).map((p) => p.gold).filter((g) => g != null);
  const en = (raw.enemy ?? []).map((p) => p.gold).filter((g) => g != null);
  const ms = my.reduce((a, b) => a + b, 0), es = en.reduce((a, b) => a + b, 0);
  return [
    `【记分板】${raw.mode ? `模式: ${raw.mode}` : ""}`,
    raw.score?.left != null ? `双方击杀: ${raw.score.left} vs ${raw.score.right}` : "",
    "我方:",
    ...rows(raw.team),
    "敌方:",
    ...rows(raw.enemy),
    my.length && en.length
      ? `已见金币合计: 我方 ${ms} vs 敌方 ${es}(${ms >= es ? "领先" : "落后"} ${Math.abs(ms - es)},仅统计读到的 ${my.length}/${en.length} 人)`
      : "",
  ].filter(Boolean).join("\n");
}

/** 赛后结算页:双方伤害/金币,以及可直接读到的双方总经济。 */
function resultBoardText(raw) {
  const rows = (arr) => (arr ?? []).map((p, i) => {
    const t = [`  ${i + 1}. KDA ${p.kda?.k ?? "?"}/${p.kda?.d ?? "?"}/${p.kda?.a ?? "?"}`];
    if (p.damage != null) t.push(`伤害 ${p.damage.toLocaleString("en-US")}`);
    if (p.gold != null) t.push(`金币 ${p.gold.toLocaleString("en-US")}`);
    return t.join("  ");
  });
  const e = raw.economy;
  return [
    `【赛后结算】${raw.result ?? ""}${raw.duration ? ` 时长 ${raw.duration}` : ""}`,
    e ? `双方总经济(本帧可读部分${e.partial ? ",不完整" : ""}): 第1队 ${e.myGold.toLocaleString("en-US")} vs 第2队 ${e.enemyGold.toLocaleString("en-US")}(${e.diff >= 0 ? "领先" : "落后"} ${Math.abs(e.diff).toLocaleString("en-US")})` : "",
    // 分队未必可靠:结算页在低分辨率下队头「第1队/第2队」常读不到,
    // 此时 companion 只能按 y 落差粗分 → 标注出来,别让模型当成确定事实。
    raw.splitConfident === false ? "⚠ 本帧未读到队伍标签,以下分队为推断,不确证" : "",
    "第1队:", ...rows(raw.team1), "第2队:", ...rows(raw.team2),
  ].filter(Boolean).join("\n");
}

function stateText(raw) {
  const s = raw.state ?? raw;
  const tf = s.teamfight ?? null;
  const tfLines = [];
  if (tf) {
    // 团战事实层由 companion 的 teamfight.mjs 产出(定位来自 DataDragon roles,
    // 出装来自 Live API,已选强化来自面板推断)。这里只做呈现,不做判断 ——
    // 具体技能细节本地没有数据,交给教练模型用它自己的英雄知识补。
    tfLines.push(`【团战 · ${tf.phaseCn ?? "?"}】`);
    if (tf.engage) tfLines.push(`开团判断: ${tf.engage}${(tf.opener ?? []).length ? `(先手: ${tf.opener.join("/")})` : ""}`);
    if (tf.stance) {
      const st = { front: "最前排(先吃第一波/开团)", flank: "侧翼绕后(等对方交技能再进)", back: "后排输出(保持距离)" }[tf.stance] ?? tf.stance;
      tfLines.push(`我的站位: ${st}`);
    }
    if ((tf.mainTarget ?? []).length) tfLines.push(`主要打谁: ${tf.mainTarget.join("/")}(敌方后排)`);
    if ((tf.avoid ?? []).length) tfLines.push(`先别管: ${tf.avoid.join("/")}(敌方前排)`);
    if (tf.threat?.name) tfLines.push(`重点盯防: ${tf.threat.name}(T${tf.threat.tier} ${tf.threat.winRate}%)`);
    if (tf.timing) tfLines.push(`进场时机: ${tf.timing}`);
    if (tf.skill) tfLines.push(`技能思路: ${tf.skill}`);
    const picked = tf.pickedAugments ?? [];
    if (picked.length) {
      // 区分两种来源:局内播报(确证) vs 面板推断(低置信度)。
      // 播报是游戏自己打出来的,可以直接当事实;推断必须标注,别让模型当真。
      const confirmed = picked.filter((p) => p.confidence !== "low");
      const inferred = picked.filter((p) => p.confidence === "low");
      if (confirmed.length) tfLines.push(`已选强化(局内播报确证): ${confirmed.map((p) => p.name).join("、")}`);
      if (inferred.length) tfLines.push(`已选强化(从画面推断,不确证): ${inferred.map((p) => p.name).join("、")}`);
    }
  }
  // ── 双方已选强化(聊天确证)───────────────────────────────────────
  // ⚠ 这一段原先**没有渲染**:companion 把它写进了 state 事件、悬浮窗也显示了,
  //   但教练读到的 stateText 里没有 → "对面拿了什么强化"这条信息在
  //   **自动播报与对话两条路径上都丢失**,针对性建议因此少了一半依据。
  //   (团队层 tf.pickedAugments 只是**我自己**的;这里是双方逐人的。)
  const ca = s.championAugments;
  if (Array.isArray(ca) && ca.length) {
    const fmtAug = (c) => `${c.champion ?? "?"}(${(c.augments ?? []).join("+")})` +
      (c.sideInferred ? "[按名单推断]" : "");
    const enemy = ca.filter((c) => c.side === "enemy");
    const ally = ca.filter((c) => c.side === "ally" || c.side === "me");
    const unknown = ca.filter((c) => c.side !== "enemy" && c.side !== "ally" && c.side !== "me");
    if (enemy.length) tfLines.push(`敌方已选强化: ${enemy.map(fmtAug).join("、")}`);
    if (ally.length) tfLines.push(`我方已选强化: ${ally.map(fmtAug).join("、")}`);
    if (unknown.length) tfLines.push(`阵营待定已选强化: ${unknown.map(fmtAug).join("、")}`);
  }
  return [
    `【局势 ${clock(s.time)}】`,
    `我: Lv${s.level ?? "?"} ${s.k ?? 0}/${s.d ?? 0}/${s.a ?? 0} 金币${s.gold ?? "?"} 补刀${s.cs ?? "?"}`,
    s.hpPct != null ? `血量: ${Math.round(s.hpPct * 100)}%${s.dead ? " (阵亡)" : ""}` : "",
    `我装备: ${fmtItems(s.items)}`,
    s.build ? `推荐出装: ${s.build}` : "",
    `双方人头: 我方${s.teamKills ?? "?"} 敌方${s.enemyKills ?? "?"}`,
    `敌方装备: ${fmtItems(s.enemyItems)}`,
    ...tfLines,
  ].filter(Boolean).join("\n");
}

/** 把事件映射成仪表盘字段。
 *  王者走的是"从中文 OCR 简报里正则抠数",端游的数据是 Live API 的**结构化字段**,
 *  两者没有共同的文本形态 —— 所以映射必须由 adapter 自己提供,内核只负责应用。
 *  返回 null 表示这个事件不携带仪表盘信息(内核保持原值)。 */
function dashboard(event) {
  const ts = (t) => {
    const v = Math.round(Number(t) || 0);
    return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
  };
  if (event.kind === "state") {
    const s = event.state ?? event;
    return {
      gameTime: ts(s.time),
      score: (s.teamKills != null && s.enemyKills != null) ? `${s.teamKills}vs${s.enemyKills}` : null,
      // 端游没有"经济差"字段,只有自己的金币 → 用金币代替,措辞交给展示层
      economy: s.gold != null ? `金币${s.gold}` : null,
      roster: {
        me: {
          champion: event.me?.champion ?? null,
          level: s.level ?? null, k: s.k ?? null, d: s.d ?? null, a: s.a ?? null,
          gold: s.gold ?? null, cs: s.cs ?? null,
          hpPct: s.hpPct ?? null, dead: !!s.dead,
          items: (s.items ?? []).map((i) => i.name).filter(Boolean),
        },
        enemyItems: (s.enemyItems ?? []).filter(Boolean),
      },
    };
  }
  if (event.kind === "game_start") {
    const me = event.me ?? {};
    return {
      gameTime: "00:00",
      score: "0vs0",
      economy: null,
      roster: {
        me: {
          champion: me.champion ?? null, level: me.level ?? 1,
          k: 0, d: 0, a: 0, gold: null, cs: 0, hpPct: 1, dead: false,
          items: (me.items ?? []).map((i) => i.name ?? i).filter(Boolean),
        },
        allies: (event.allies ?? []).map((p) => p.champion).filter(Boolean),
        enemies: (event.enemies ?? []).map((p) => p.champion).filter(Boolean),
      },
    };
  }
  return null;
}

function eventText(raw) {
  const who = [raw.killer, raw.victim].filter(Boolean).join(" → ");
  const tail = [raw.turret, raw.inhibitor, raw.dragon, raw.recipient].filter(Boolean).join(" ");
  return [`【战况 ${clock(raw.time)}】${EVENT_CN[raw.name] ?? raw.name}`, who, tail].filter(Boolean).join(" ");
}

/** 日志行的时刻(ms)。companion 写入 t 字段(epoch ms)。 */
function eventTime(raw) {
  const t = Number(raw?.t);
  return Number.isFinite(t) && t > 0 ? t : null;
}
//#endregion

//#region 过滤与分级(filter)
/** 噪音过滤:界面文字、空 OCR、无意义阶段变化 → 不触发对话。 */
/**
 * 哪些 kind 的正文是**我们自己按结构化字段生成**的(不是从屏幕上抄来的)。
 *
 * 为什么必须区分:NOISE_RE 是给**屏幕文字**用的启发式(「正在加载」「设置」「符文」
 * 这类界面词)。而结构化事件的 text 由 adapter 自己拼,里面出现「符文」只可能是
 * 我们在解释业务(实测:`loading_roster` 的说明句里有「符文」→ 被 NOISE_RE 命中 →
 * isRelevant=false → **敌方阵容被静默丢弃**,而它正是针对性建议的唯一依据)。
 * 对这类事件跑 NOISE_RE 只有假阴性、没有收益。
 */
const STRUCTURED_KINDS = new Set([
  "loading_roster", "vision", "scoreboard", "result_board", "champ_select", "load",
  "game_start", "augment_offer", "shard_offer", "augment_picked", "augment_mutate",
  "chat_events", "state", "phase", "player_stats",
]);

function isRelevant(event) {
  if (!event) return false;
  if (event.kind === "phase") return PHASE_WORTHY.has(event.phase);
  if (event.kind === "ocr") {
    const text = String(event.text ?? "").replace(/^\[[^\]]*\]\s*/, "").trim();
    if (!text || NOISE_RE.test(text)) return false;
    // 至少要有中文或两位以上字母/数字,才可能是有效内容
    return /[\u4e00-\u9fa5]{2,}|[A-Za-z0-9]{2,}/.test(text);
  }
  // 结构化事件的正文是我们自己生成的,不适用"屏幕噪音"启发式(见 STRUCTURED_KINDS)
  if (STRUCTURED_KINDS.has(event.kind)) return true;
  const text = String(event.text ?? "");
  if (text && NOISE_RE.test(text) && event.kind !== "interaction") return false;
  return true;
}

/**
 * 上下文事件:只富化同窗口的触发回合,自身不触发(避免每 2 秒一次的轮询把回合撑爆)。
 * · state(局内轮询快照)—— 信息量大但高频,作为上下文最合适;
 * · ocr 里 source=scoreboard/shop 的常规识别同理。海克斯面板必须自己触发,故不在此列。
 */
function contextOnly(event) {
  if (!event) return false;
  if (event.kind === "state") return true;
  if (event.kind === "ocr" && (event.source === "scoreboard" || event.source === "shop")) return true;
  return false;
}

/** 事实指纹:同一事实(局势数值未变 / 同一批强化)不重复播报。 */
function isFactChanged(event, st, sourceFile) {
  if (!event) return false;
  const key = `${sourceFile ?? "-"}:${event.kind}:${event.key ?? ""}`;
  if (event.kind === "state") return true; // state 已是 contextOnly,不会被这里拦
  if (event.kind === "event") {
    // 战况事件用 EventID 去重(companion 会带 id)
    if (event.id != null) {
      if (st.seenEventIds.has(event.id)) return false;
      st.seenEventIds.add(event.id);
      if (st.seenEventIds.size > 2000) st.seenEventIds = new Set([...st.seenEventIds].slice(-500));
    }
    return true;
  }
  if (event.kind === "augment_offer") {
    const fp = (event.options ?? []).map((o) => o.name).join("|");
    if (!fp) return true;
    if (st.lastAugmentFp === fp) return false;
    st.lastAugmentFp = fp;
    return true;
  }
  if (event.kind === "shard_offer") {
    // 属性碎片三选一:同一组碎片不重复问(与海克斯各自独立记指纹)
    const fp = (event.options ?? []).map((o) => o.name).join("|");
    if (!fp) return true;
    if (st.lastShardFp === fp) return false;
    st.lastShardFp = fp;
    return true;
  }
  if (event.kind === "champ_select") {
    const fp = `${event.me?.champion ?? ""}|${(event.enemies ?? []).map((e) => e.champion).join(",")}`;
    if (st.lastChampSelectFp === fp) return false;
    st.lastChampSelectFp = fp;
    return st.champSelectFpAt !== undefined || true;
  }
  // 通用:文本指纹 + 过期时间
  const fp = `${key}:${String(event.text ?? "").slice(0, 80)}`;
  const last = st.fp.get(fp);
  const now = Date.now();
  if (last != null && now - last < 60000) return false;
  st.fp.set(fp, now);
  if (st.fp.size > 400) for (const [k, t] of st.fp) if (now - t > 180000) st.fp.delete(k);
  return true;
}

/** 批次信号分级:高信号立即触发,其余受内核低信号限流。 */
function isHighSignal(events, st) {
  for (const e of events ?? []) {
    if (!e) continue;
    if (e.kind === "interaction") return true;
    if (e.kind === "augment_offer" || e.kind === "champ_select" || e.kind === "load" || e.kind === "game_start") return true;
    // 加载页阵容是"敌方是谁"的唯一来源,后面所有针对性建议都依赖它 —— 必须立即触发
    if (e.kind === "loading_roster") return true;
    // 画面兜底每次约 6s + 一次云端调用,触发频率本来就低(有节流),拿到结果就立即送
    if (e.kind === "vision") return true;
    if (e.kind === "shard_offer") return true;   // 属性碎片三选一:同样必须立即触发
    if (e.kind === "augment_picked") return true;
    // 记分板/结算页都是玩家主动产生的信息密度极高的快照,值得立即送进对话
    if (e.kind === "scoreboard" || e.kind === "result_board") return true;
    // 强化质变是局内播报确证(高置信度),不同于面板推断 —— 立即送
    if (e.kind === "augment_mutate") return true;
    // 局内事件逐条都送会把对话刷爆(一局几十条击杀)。只有**真正值得打断**的才立即触发:
    // 多杀/超神/团灭/大龙小龙/防御塔,或事件本身出现在我方身上。
    if (e.kind === "chat_events" && HIGH_SIGNAL_CHAT_RE.test(e.text ?? "")) return true;
    if (e.kind === "event" && HIGH_SIGNAL_RE.test(e.text ?? "")) return true;
    if (e.kind === "ocr" && HIGH_SIGNAL_RE.test(e.text ?? "")) return true;
  }
  return false;
}

/** 上下文快照归并键(同类只保留最新)。 */
function contextKey(event) {
  if (!event) return null;
  if (event.kind === "state") return "lol:state";
  if (event.kind === "ocr") return `lol:ocr:${event.source ?? "unknown"}`;
  return `${event.kind}:${event.key ?? ""}`;
}
//#endregion

//#region 提示词拼装(prompt)
const KIND_TAG = {
  interaction: "玩家提问",
  champ_select: "选人界面",
  load: "加载页",
  loading_roster: "加载页阵容",
  vision: "画面识别",
  augment_offer: "海克斯选择",
  shard_offer: "属性碎片选择",
  augment_picked: "海克斯已选",
  scoreboard: "记分板",
  augment_mutate: "强化质变",
  chat_events: "局内事件",
  result_board: "赛后结算",
  game_start: "开局",
  state: "当前局势",
  event: "战况",
  ocr: "屏幕识别",
  phase: "流程",
};

function toLine(ev, i) {
  const tag = KIND_TAG[ev.kind] ?? ev.kind;
  const content = ev.kind === "interaction"
    ? (ev.context?.content ?? ev.text ?? "")
    : (ev.text ?? ev.key ?? "");
  return `[观察${i + 1}·${tag}] ${String(content).slice(0, 500)}`;
}

/** 单事件 → 请求体(interaction 立即触发时用)。 */
/**
 * 观察文本里"本地数据没有"的信号词。
 *
 * 为什么要有它:工具(preset 里的 web_search/site_query)一直都有,人设也写着
 * 「不得凭空补全」—— 但**没有任何机制**把"这里缺数据"告诉模型,于是它多半就
 * 直接按已有信息说完了(实测:日志里找不到一次 web_search 的使用痕迹)。
 * 这里照 vision 的做法:把"缺什么"变成**确定性的信号**,而不是指望模型自觉。
 */
const UNCERTAIN_RE = /待定|未识别|未知|无可用效果描述|不在库内|本地无描述|unresolved|名称待定/;

/** 缺口提示。only 在真检出缺口时才拼,避免每轮都塞一段噪音。 */
function lookupHint(text) {
  if (!UNCERTAIN_RE.test(String(text ?? ""))) return "";
  return (
"\n\n⚠ **本条观察里有本地数据没有的部分**(见上面的『待定/未识别/未知』)。" +
"如果它会改变你的结论,先用 web_search 查清楚再回答(查英雄机制/强化效果/装备都可以);" +
"查不到或拿不准就**明说这一条你不确定**,不要猜 —— 猜错的强化效果会让整条建议针对错对象。"
  );
}

function eventToBody(event, opts = {}) {
  if (!event) return null;
  return {
    prompt:
      `【实时对局观察】\n${toLine(event, 0)}\n\n` +
      `请基于以上观察给出下一步建议(≤50字,口语化,先结论后依据);若纯状态无变化可输出空串。` +
      lookupHint(toLine(event, 0)),
    system_prompt: opts.systemPrompt || PERSONA_SYSTEM_PROMPT,
    // ⚠ 这里**不要**写死 model。原先写着 "qwen3.6-plus",而**没有任何地方读它** ——
    //   真正生效的是 coach-server 配置里的 cfg.provider / cfg.model
    //   (index.js 的 llm 调用与 agentOptions 都从那里取)。
    //   写死的值只会让人以为「教练对话跑在 qwen 上」,与事实相反;
    //   实际全部云端调用都是 opencode-go / deepseek-v4.1-flash。
    _count: 1,
  };
}

/** 事件数组 → 请求体(聚合窗口)。 */
function eventsToBody(events, opts = {}) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const ordered = [...events].sort((a, b) => (a.kind === "interaction" ? 0 : 1) - (b.kind === "interaction" ? 0 : 1));
  const lines = ordered.map(toLine);
  return {
    // 注意:不要写"合并 N 条"这类裸数字(会被模型误读为比分)
    prompt:
      `【实时对局观察(海克斯大乱斗,按时间先后排列)】\n${lines.join("\n")}\n\n` +
      `请基于以上实时观察给出下一步的简短播报建议(≤50字,口语化,说给正在打游戏的玩家听);` +
      `若均为纯状态无变化可输出空串。` +
      lookupHint(lines.join("\n")),
    system_prompt: opts.systemPrompt || PERSONA_SYSTEM_PROMPT,
    // ⚠ 这里**不要**写死 model。原先写着 "qwen3.6-plus",而**没有任何地方读它** ——
    //   真正生效的是 coach-server 配置里的 cfg.provider / cfg.model
    //   (index.js 的 llm 调用与 agentOptions 都从那里取)。
    //   写死的值只会让人以为「教练对话跑在 qwen 上」,与事实相反;
    //   实际全部云端调用都是 opencode-go / deepseek-v4.1-flash。
    _count: events.length,
  };
}
//#endregion

/** 英雄联盟 adapter。 */
export const LOL_ADAPTER = {
  id: "lol",
  name: "英雄联盟",
  version: 1,
  persona: {
    systemPrompt: PERSONA_SYSTEM_PROMPT,
    maxReplyTokens: 80,
    replyDescription: "输出本次教练请求的最终播报文本(≤50字)。调用后本次请求即完成。",
    replyParamDescription: "最终播报文本,可为空字符串(表示静音)",
  },
  deepKeywords: ["出装", "天赋", "符文", "对线", "团战", "开团", "海克斯", "强化", "阵容", "克制", "强度", "胜率", "连招", "复盘", "节奏"],
  monitorInit: {
    prompt: '监控会话初始化,请只回复"就绪"二字。',
    system_prompt: "你是英雄联盟端游助手金宝的监控会话,回复极简。",
  },
  eventToBodySystemPrompt: PERSONA_SYSTEM_PROMPT,
  view: {
    // 端游默认 1920x1080;截图与悬浮窗都用这个坐标系
    ocrCanvas: { w: 1920, h: 1080 },
    // 海克斯三选一面板区域 —— **真机实测 + 像素级测量**(2026-09-13,41 帧真实对局截图):
    //   OCR 文字框反推只能得到"标题所在行",会**漏掉卡片上半部分的图标区**。
    //   有视觉后用 measure-panel.py 直接量卡片边框,三帧结果高度一致:
    //     竖边框 x ≈ 448/748 · 816/1116 · 1184/1484(卡宽 ≈ 290~300)
    //     横边框 y ≈ 202..709(卡高 ≈ 500~507)
    //   故卡片整体 ROI ≈ [440, 190, 1055, 528](1920x1080)。
    augmentRoi: { left: 440, top: 190, width: 1055, height: 528 },
    // 只要**标题行**用于读强化名(卡片整体 ROI 用于"是不是面板"的判定);
    // 标题实测 y≈428..459,两侧留边 → 单帧 OCR 约 1.3s(卡整体要 ~2.1s)
    augmentTitleRoi: { left: 440, top: 400, width: 1055, height: 90 },
    // 比例形式:换分辨率时按窗口尺寸换算(1920x1080 下与上面等价)
    augmentRoiFrac: { left: 0.229, top: 0.176, width: 0.549, height: 0.489 },
    augmentTitleRoiFrac: { left: 0.229, top: 0.370, width: 0.549, height: 0.083 },
    overlay: { anchor: "top-right", width: 420, height: 260 },
    // 仪表盘字段映射:端游数据是结构化的,由 adapter 自己解释(内核不再猜文本)
    dashboard,
  },
  dialogKinds: new Set(["interaction", "champ_select", "load", "loading_roster", "vision", "augment_offer", "shard_offer", "augment_picked", "augment_mutate", "chat_events", "game_start", "scoreboard", "result_board", "state", "event", "ocr"]),
  log: { classify, eventTime },
  filter: { isRelevant, contextOnly, isFactChanged, isHighSignal, contextKey },
  prompt: { eventToBody, eventsToBody },
  createState() {
    return {
      seenEventIds: new Set(),   // 战况事件去重
      lastAugmentFp: null,        // 同一批海克斯不重复问
      lastShardFp: null,          // 同一批属性碎片不重复问(与海克斯各自独立)
      lastChampSelectFp: null,
      fp: new Map(),              // 通用文本指纹
    };
  },
};

export default LOL_ADAPTER;
