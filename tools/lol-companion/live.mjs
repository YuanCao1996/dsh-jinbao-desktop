// live.mjs — Live Client Data API(游戏内实时数据)
// ----------
// 游戏进程在 127.0.0.1:2999 暴露的**只读**本地 HTTPS 接口,进游戏后才有。
// 这是端游相对手游最大的优势:等级/金币/KDA/装备/血量/事件全部结构化,
// 不需要 OCR。OCR 只用来补 API 拿不到的东西(海克斯三选一卡片等)。
//
// 端点:
//   GET /liveclientdata/allgamedata   → 全量(本模块默认用这个)
//   GET /liveclientdata/activeplayer  → 自己
//   GET /liveclientdata/playerlist    → 十人
//   GET /liveclientdata/eventdata     → 事件
//   GET /liveclientdata/gamestats     → 局内统计
import https from "node:https";

export const LIVE_BASE = "https://127.0.0.1:2999";

/** 请求 Live Client Data 端点。失败抛错(调用方自行判定"未进游戏")。 */
export function liveRequest(path, { timeoutMs = 2500, base = LIVE_BASE } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: "127.0.0.1", port: 2999, path, method: "GET", rejectUnauthorized: false, timeout: timeoutMs, headers: { accept: "application/json" } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 0) !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          try { resolve(JSON.parse(text)); } catch (e) { reject(new Error("响应非 JSON")); }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("Live Client 请求超时")));
    req.on("error", reject);
    req.end();
  });
}

/** 是否在游戏内(2999 是否可用)。 */
export async function liveAvailable() {
  try {
    await liveRequest("/liveclientdata/gamestats", { timeoutMs: 1200 });
    return true;
  } catch {
    return false;
  }
}

/** 全量数据;未进游戏返回 null。 */
export async function getAllGameData() {
  try {
    return await liveRequest("/liveclientdata/allgamedata", { timeoutMs: 2500 });
  } catch {
    return null;
  }
}

/** 归一化后的名字比较:忽略大小写与首尾空白。 */
const normName = (s) => String(s ?? "").trim().toLowerCase();
/** 去掉 `#tag` 再比(国服 summonerName 是空串、riotId 带 tag,两边可能一边带一边不带)。 */
const tagless = (s) => normName(s).split("#")[0];

/**
 * 在十人名单里认出**自己那一行**(原始条目,带 team 字段)。
 *
 * 为什么要单独一步:Live API 的 `team` 是 ORDER/CHAOS 两个**阵营名**,而玩家在哪一边
 * 是随机的(大乱斗红蓝都可能)。只有先认出自己那一行,才知道"我方"是 ORDER 还是 CHAOS。
 *
 * 匹配顺序:puuid → riotId → summonerName。前三个都失配时,才用"去掉 #tag 再比"
 * 的宽松规则,而且**只有唯一命中才敢认**(同局里可能存在同 gameName 不同 tag 的两个人,
 * 那种情况下宁可不认 —— 认错的代价是整局敌我颠倒)。
 */
function findActiveEntry(players, ap) {
  const exact = (a, b) => { const x = normName(a), y = normName(b); return !!x && x === y; };
  const hit = (p) =>
    (ap.puuid && p.puuid && p.puuid === ap.puuid) ||
    exact(p.riotId, ap.riotId) ||
    exact(p.summonerName || p.riotId, ap.summonerName) ||
    exact(p.riotId, ap.summonerName) ||
    exact(p.summonerName || p.riotId, ap.riotId);
  const first = players.find(hit);
  if (first) return first;
  const loose = players.filter((p) =>
    (ap.riotId && tagless(p.riotId) === tagless(ap.riotId)) ||
    (ap.summonerName && tagless(p.summonerName || p.riotId) === tagless(ap.summonerName)));
  return loose.length === 1 ? loose[0] : null;
}

/** 把 allgamedata 压成一份"我方视角"的紧凑状态(只留叶子字段,不搬运原始对象)。
 *  加载期(还在读条)返回 200 但字段为空 → 这里返回 null,避免产出 mode="" time=0 的假事件。
 *
 *  ⚠⚠ **敌我是按"我自己那一行的 team"分的,不是按 ORDER**(2026-09-27 真机事故):
 *    早期写死 `p.team === "ORDER" ? order : chaos`,等于假设"我永远在 ORDER 那一边"。
 *    那一局(凯隐)玩家在 CHAOS → companion 的敌我**整份反过来**:
 *      · 悬浮窗「团战」页把队友列成「主要打谁: 卡尔萨斯(敌方后排)」,
 *        又把自己列进「先别管: 塔姆/奥恩/蒙多医生/凯隐(前排,交给队友)」;
 *      · 「对手」页里同一个 Noble丶Ys#31060 同时出现在"敌"和"我"两行;
 *      · 出装页把**自己的装备**当成敌方装备(影流之镰 3/8/9 与我完全一致);
 *      · 加载页的阵营判定也连带被带偏(它拿 rt.allies 当"选人阵容",而那份已被覆盖成对面)。
 *    铁证(同一局日志):`01:17 Noble、Ys (影流之镰)已终结了写不漏(纳祖芒荣耀)` ——
 *    玩家亲手击杀的奎桑提,当时正被列在**我方**名单里。
 *    所以:先认自己 → 用自己那一行的 team 当"我方";认不出自己时**退回 ORDER 假设并把
 *    这件事标出来**(sideSource),由上层记进日志 —— 静默用错阵营正是这次事故的根因。
 */
export function compactState(all) {
  if (!all) return null;
  // 真机实测:游戏还在加载时 allgamedata 返回的是不含 allPlayers/gameData 的残缺体
  if (!Array.isArray(all.allPlayers) || all.allPlayers.length === 0 || !all.gameData) return null;
  const ap = all.activePlayer ?? {};
  const meRaw = findActiveEntry(all.allPlayers, ap);
  // 我方是哪个阵营:以**自己那一行**为准;认不出自己才退回 ORDER 假设(并如实标注)
  const myTeam = meRaw?.team || null;
  const sideSource = myTeam ? "activePlayer.team" : "assumed-ORDER";
  const mySide = myTeam ?? "ORDER";
  const order = [], chaos = [];
  let me = null;
  for (const p of all.allPlayers ?? []) {
    const one = {
      // ⚠ 用 `||` 而不是 `??`:国服实测 summonerName 是**空字符串**(不是 null/undefined),
      //   `"" ?? x` 会保留空串,导致后面按名字找自己时全部失配(踩过)。
      name: p.summonerName || p.riotId || "?",
      // ── 身份(查战绩用的键)──────────────────────────────────────────
      // Live API 的 allPlayers 直接带 puuid 和 riotId,所以**局内根本不需要 OCR 名字**
      // 就能拿到可查询的身份。加载页 OCR 只在读条期(Live API 还返回残缺体)兜底,
      // 而且它只写 gameName、不写 #tag(截图像素级核对过)。
      puuid: p.puuid ?? null,
      riotId: p.riotId ?? (p.riotIdGameName ? `${p.riotIdGameName}#${p.riotIdTagLine ?? ""}` : null),
      champion: p.championName ?? "?",
      // 国服 championName 是**称号**(Ashe → "寒冰射手");rawChampionName 里带着英文别名
      // (game_character_displayname_Ashe),解析出来给上层做精确查表用。
      championRaw: p.rawChampionName ?? "",
      championAlias: (/(?:displayname|name)_([A-Za-z0-9]+)$/.exec(p.rawChampionName ?? "")?.[1]) ?? "",
      team: p.team ?? "",
      level: p.level ?? 0,
      k: p.scores?.kills ?? 0,
      d: p.scores?.deaths ?? 0,
      a: p.scores?.assists ?? 0,
      cs: p.scores?.creepScore ?? 0,
      items: (p.items ?? []).map((it) => ({ id: it.itemID, name: it.displayName, count: it.count ?? 1 })),
      dead: !!p.isDead,
      respawn: p.respawnTimer ?? 0,
      spells: (p.summonerSpells ? Object.values(p.summonerSpells).map((s) => s.displayName) : []),
    };
    // 原始两排仍按 API 的阵营名归堆(诊断用),谁是我方由上面 mySide 决定
    (p.team === "ORDER" ? order : chaos).push(one);
    if (p === meRaw) me = one;
  }
  // `allies` / `enemies` 才是"我方视角"的那一份 —— **下游一律用它俩**。
  // order/chaos 只保留 API 原义(供 probe/诊断),不要拿它们判敌我。
  const allies = mySide === "ORDER" ? order : chaos;
  const enemies = mySide === "ORDER" ? chaos : order;
  // 兜底:名字匹配失败(极端情况)时,按老办法在归一化条目里再找一遍自己 ——
  // 找不到就是找不到(me 各字段为空),但**不要**因此把阵营也悄悄改掉。
  if (!me) {
    me = [...order, ...chaos].find(
      (p) => (ap.summonerName && p.name === ap.summonerName) || (ap.riotId && p.name === ap.riotId)
    ) ?? null;
  }
  const stats = ap.championStats ?? {};
  return {
    gameTime: Math.round(all.gameData?.gameTime ?? 0),
    mode: all.gameData?.gameMode ?? "",
    mapName: all.gameData?.mapName ?? "",
    mapNumber: all.gameData?.mapNumber ?? 0,
    me: {
      champion: me?.champion ?? "",
      championAlias: me?.championAlias ?? "",
      // 我自己的身份:查"我的战绩"、以及在十人里认出哪一行是我时要用
      puuid: me?.puuid ?? null,
      riotId: me?.riotId ?? null,
      level: ap.level ?? 0,
      gold: Math.round(ap.currentGold ?? 0),
      hp: stats.currentHealth ?? 0,
      maxHp: stats.maxHealth ?? 0,
      resource: Math.round((stats.resourceValue ?? 0)),
      maxResource: Math.round((stats.resourceMax ?? 0)),
      ad: Math.round(stats.attackDamage ?? 0),
      ap: Math.round(stats.abilityPower ?? 0),
      armor: Math.round(stats.armor ?? 0),
      mr: Math.round(stats.magicResist ?? 0),
      haste: Math.round(stats.abilityHaste ?? 0),
      moveSpeed: Math.round(stats.moveSpeed ?? 0),
      dead: !!me?.dead,
      respawn: me?.respawn ?? 0,
      k: me?.k ?? 0, d: me?.d ?? 0, a: me?.a ?? 0, cs: me?.cs ?? 0,
      items: me?.items ?? [],
      spells: me?.spells ?? [],
    },
    // 我方视角的两份名单(下游判敌我只用这两个)
    allies, enemies,
    // 这一局的"我方"是哪个阵营、凭什么判的 —— 上层要记进日志(见函数头的事故注释)
    myTeam, sideSource,
    // API 原义的两排(ORDER/CHAOS),仅供诊断/探针,**不要**拿来判敌我
    order, chaos,
    events: (all.events?.Events ?? []).map((e) => ({
      id: e.EventID, name: e.EventName, time: e.EventTime,
      killer: e.KillerName ?? "", victim: e.VictimName ?? "",
      turret: e.TurretKilled ?? "", inhibitor: e.InhibitorKilled ?? "",
      dragon: e.DragonType ?? "", stalker: e.Stolen ?? "",
      recipient: e.Recipient ?? "", gold: e.Gold ?? null,
    })),
  };
}

/** 新增事件(与上次已见 EventID 比较,只返回新事件)。 */
export function diffEvents(prevMaxId, all) {
  const evs = all?.events?.Events ?? [];
  const fresh = evs.filter((e) => (e.EventID ?? 0) > prevMaxId);
  const maxId = evs.reduce((m, e) => Math.max(m, e.EventID ?? 0), prevMaxId);
  return { fresh, maxId };
}

/**
 * 判「Live API 的这一行是不是我自己」—— 双方名单/装备列表要把自己排除掉
 * (自己那一行已经在「我的当前装备」「我」那两处了)。
 *
 * ⚠ 比之前**必须归一化**:Live API 的 `champion` 是**称号**(影流之镰),而 rt.me.champion
 *   是**本名**(凯隐)—— 直接 `!==` 永远不相等,于是"我方当前装备"里会把自己的那一行
 *   再列一遍。2026-09-27 排查团战页敌我时顺带发现:那一行当时被列进了「敌方」,
 *   看着就像"对面也有个影流之镰"(其实是自己)。
 *
 * @param entry compactState 里的一行 {champion, championAlias, puuid}
 * @param self  { champion, championAlias, puuid }(champion 传本名,调用方已归一化)
 * @param resolveName 可选:称号/别名 → 本名,通常是 (x) => data.champion(x)?.name
 */
export function isSelfEntry(entry, self = {}, resolveName = null) {
  if (!entry || !self) return false;
  // puuid 最硬:两边都有就一定对(它不受称号/本名影响)
  if (entry.puuid && self.puuid) return entry.puuid === self.puuid;
  const norm = (x) => {
    const v = x ?? "";
    const r = resolveName ? resolveName(v) : null;
    return String(r || v).trim();
  };
  const a = norm(entry.championAlias || entry.champion);
  const b = norm(self.championAlias || self.champion);
  return !!a && !!b && a === b;
}
