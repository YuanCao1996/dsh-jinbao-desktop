// player-stats.mjs — 用**客户端自己的本地接口**查某个玩家的大乱斗战绩
// ----------
// 为什么走 LCU 而不是第三方(2026-09-20 真机实测结论,见 PLAN §8.32):
//   · 101 数据站只有英雄数据(它自己写明"个性化战绩请下载掌盟"),没有玩家页;
//   · OP.GG / aramgg 等第三方**不覆盖国服**(Riot 官方 API 不含腾讯服);
//   · 而客户端本地的 `/lol-match-history/v1/products/lol/{puuid}/matches` **能查任意玩家** ——
//     实测 4/4 个同局玩家全部 200,能直接算出"最近 20 局大乱斗胜率"。
//
// ⚠ 三个实测踩到的坑,决定了这里的写法:
//   1) **列表接口被瘦身**:每局只回 1 条 participantIdentities / 1 条 participants
//      (就是被查的那个人)。所以解析时**不能假设有 10 个人**,也不能靠"按 puuid 在
//      identities 里找"这种只在完整数据里成立的做法 —— 要允许"只有一条就直接用它"。
//   2) `lol-career-stats` 在国服**不存在**(任何路径都 404 Invalid URI format),
//      所以没有"生涯总胜率"这种现成字段,胜率只能**自己按最近 N 局算**。
//   3) 名字反查(`/lol-summoner/v1/summoners?name=`)必须带 `#tag`,而加载页只写 gameName。
//      因此这层的入口统一是 **puuid**,由 Live API 的 allPlayers 提供(局内直接带 puuid)。

/** 大乱斗系队列:2400=海克斯大乱斗(KIWI),450=极地大乱斗。 */
export const ARAM_QUEUE_IDS = [2400, 450];

/**
 * 大乱斗系的 gameMode。**为什么要按模式再兜一层**:
 * 真机实测(2026-09-20)国服同一个人近 20 局里出现过 `2400|KIWI`、`4310|JADE`、`900|URF` ——
 * 队列 id 是会增删的(4310 就是新出现的),而 `KIWI` 这个模式标识是海克斯大乱斗的本体。
 * 只认队列 id 的话,哪天官方换个 id 就会**静默统计不到**(而且看起来只是"没记录")。
 * `ARAM` 对应极地大乱斗。 */
export const ARAM_GAME_MODES = new Set(["KIWI", "ARAM"]);

/** 队列 id → 人话(只列我们关心的;未知的直接显示 id)。 */
export function queueName(id) {
  const n = Number(id);
  if (n === 2400) return "海克斯大乱斗";
  if (n === 450) return "极地大乱斗";
  if (n === 900) return "无限火力";
  if (n === 420) return "单双排";
  if (n === 440) return "灵活排位";
  return `队列${id}`;
}

/**
 * 从 match-history 响应里取出"这个 puuid 在这批对局里的战绩"。**纯函数**。
 *
 * @param resp   `/lol-match-history/v1/products/lol/{puuid}/matches` 的返回体
 * @param puuid  被查的人
 * @param opts.queues 只统计这些队列(默认大乱斗两种)
 * @returns {{games:number, wins:number, losses:number, winRate:number|null,
 *            k:number, d:number, a:number, kda:number|null,
 *            avgMinutes:number|null, lastAt:number|null, queueCounts:object,
 *            skipped:{queue:number, otherQueue:number, malformed:number}}}
 */
export function parseMatchList(resp, puuid, opts = {}) {
  const queues = new Set((opts.queues ?? ARAM_QUEUE_IDS).map(Number));
  const modes = opts.modes ?? ARAM_GAME_MODES;
  const list = resp?.games?.games ?? resp?.games ?? [];
  const games = Array.isArray(list) ? list : [];
  const out = {
    games: 0, wins: 0, losses: 0, winRate: null,
    k: 0, d: 0, a: 0, kda: null,
    avgMinutes: null, lastAt: null, queueCounts: {}, modeCounts: {},
    skipped: { queue: 0, malformed: 0, unknownResult: 0 },
  };
  let durSum = 0, durN = 0;

  for (const g of games) {
    if (!g || typeof g !== "object") { out.skipped.malformed++; continue; }
    const qid = Number(g.queueId);
    const mode = String(g.gameMode ?? "");
    out.queueCounts[qid] = (out.queueCounts[qid] ?? 0) + 1;
    if (mode) out.modeCounts[mode] = (out.modeCounts[mode] ?? 0) + 1;
    // 队列 id 命中 **或** 模式命中(模式是兜底:官方换队列 id 时仍能统计到)
    if (!queues.has(qid) && !modes.has(mode)) { out.skipped.queue++; continue; }

    const mine = pickSelf(g, puuid);
    if (!mine) { out.skipped.malformed++; continue; }
    const win = mine.stats?.win;
    if (win !== true && win !== false) { out.skipped.unknownResult++; continue; }

    out.games++;
    if (win) out.wins++; else out.losses++;
    out.k += Number(mine.stats?.kills ?? 0);
    out.d += Number(mine.stats?.deaths ?? 0);
    out.a += Number(mine.stats?.assists ?? 0);
    const created = Number(g.gameCreation ?? 0);
    if (created && (out.lastAt === null || created > out.lastAt)) out.lastAt = created;
    const dur = Number(g.gameDuration ?? 0);
    if (dur > 0) { durSum += dur; durN++; }
  }

  if (out.games > 0) {
    out.winRate = Math.round((out.wins / out.games) * 100);
    // KDA =(击杀+助攻)/死亡;0 死亡按 1 计(与客户端惯例一致)避免除零
    out.kda = Math.round(((out.k + out.a) / Math.max(1, out.d)) * 10) / 10;
  }
  if (durN > 0) out.avgMinutes = Math.round((durSum / durN / 60) * 10) / 10;
  return out;
}

/**
 * 在这一局里找出"被查的人"的 participant 记录。
 *
 * 国服的列表接口**只回他自己那一条**,所以顺序是:
 *   ① identities 里 puuid 完全匹配 → 用它;
 *   ② 只有一条 identity → 直接认为就是他(这是国服列表接口的**正常形态**,
 *      不是兜底 —— 把它当异常处理会让整条链路永远算不出胜率);
 *   ③ 用 summonerId 匹配(调用方可能只知道 id)。
 */
export function pickSelf(game, puuid, summonerId) {
  const ids = game.participantIdentities ?? [];
  const parts = game.participants ?? [];
  if (!ids.length || !parts.length) return null;
  const byPid = (pid) => parts.find((p) => p.participantId === pid) ?? null;

  let hit = puuid ? ids.find((it) => it?.player?.puuid === puuid) : null;
  if (!hit && summonerId !== undefined && summonerId !== null) {
    hit = ids.find((it) => String(it?.player?.summonerId) === String(summonerId));
  }
  if (!hit && ids.length === 1) hit = ids[0];
  if (!hit) return null;
  return byPid(hit.participantId);
}

/** 秒级时间戳 → "刚刚 / 3 小时前 / 2 天前" */
export function agoText(ts, now = Date.now()) {
  if (!ts) return "";
  const d = Math.max(0, now - ts);
  const min = Math.floor(d / 60000);
  if (min < 60) return min <= 1 ? "刚刚" : `${min}分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}小时前`;
  return `${Math.floor(h / 24)}天前`;
}

/**
 * 一行紧凑的"对手战绩"(给悬浮窗战况页用)。**纯函数**。
 * 形如:`斯莫德40% 斯维因60% 厄运小姐45%`(名字过长会截断)
 */
// ── 列对齐辅助(全模块共用一份)────────────────────────────────────────
// ⚠ 悬浮窗是**比例字体**,半角空格宽度 ≠ 半个汉字 → padEnd 补了也对不齐。
//   而 CJK 字符在中文 UI 字体里**都是等宽(全角)**的,所以按"显示宽度"补,
//   并且用**全角空格 U+3000** 填 —— 值列才会落在同一条竖线上。
//   真机现象(对手页):`敌 斯莫德     40%` 与 `敌 厄运      45%` 的百分比错开。
const cjkW = (s) => [...String(s)].reduce((n, c) => n + (/[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(c) ? 2 : 1), 0);
const padCjk = (s, target) => {
  const d = target - cjkW(s);
  return String(s) + "\u3000".repeat(Math.max(0, Math.floor(d / 2))) + (d % 2 ? " " : "");
};
export function enemyLineText(rows, opts = {}) {
  const list = (rows ?? []).filter((r) => r.team === "enemy" && r.winRate !== null);
  if (!list.length) return "";
  const maxName = opts.maxName ?? 5;
  // ⚠ 对齐要用**全角空格**补齐,不能用半角空格:
  //   悬浮窗是**比例字体**,半角空格宽度 ≠ 半个汉字 → 补了也对不齐。
  //   而 CJK 字符在中文 UI 字体里**都是等宽(全角)**的,把每个名字补到同一个
  //   "全角宽度",值列就自然落在一条竖线上。
  //   真机现象:原来是 `斯莫德40% 斯维因60% 厄运45% 提莫55% 潘森50%` ——
  //   名字 2~3 字不等、直接串在一起,参差不齐。

  const wName = Math.max(...list.map((r) => cjkW(String(r.champion ?? "?").slice(0, maxName))));
  return list.map((r) => {
    const name = String(r.champion ?? "?").slice(0, maxName);
    return `${padCjk(name, wName)} ${String(r.winRate).padStart(3)}%`;
  }).join("  ");
}

/**
 * 完整表格文本(给悬浮窗「对手」页用)。**纯函数**。
 * 敌方在前 —— 需要针对的是他们(与 championAugmentRows 同一约定)。
 */
export function statsTableText(rows, opts = {}) {  if (!rows?.length) return "";
  const now = opts.now ?? Date.now();
  const order = { enemy: 0, ally: 1, me: 2, unknown: 3 };
  const sorted = [...rows].sort((a, b) => (order[a.team] ?? 9) - (order[b.team] ?? 9));
  const lines = [];
  for (const r of sorted) {
    const side = r.team === "enemy" ? "敌" : r.team === "me" ? "我" : r.team === "ally" ? "友" : "?";
        // ⚠ 原来是 .padEnd(6, " ") —— 半角空格,比例字体下 3 字名与 2 字名对不齐
    const name = padCjk(String(r.champion ?? "?").slice(0, 6), 12);
    if (r.winRate === null || r.winRate === undefined) {
      const why = r.error ? `查询失败(${r.error})` : "近期无大乱斗记录";
      lines.push(`${side} ${name} —  ${why}`);
      continue;
    }
    const gap = agoText(r.lastAt, now);
    lines.push(`${side} ${name} ${String(r.winRate).padStart(3)}%  ` +
      `${String(r.games).padStart(2)}局 ${String(r.kda ?? "-").padStart(4)} KDA` +
      (gap ? `  ${gap}` : ""));
  }
  return lines.join("\n");
}

/**
 * 「对手」页的**主视图**:名单 + 战绩合成一张表。**纯函数**,悬浮窗与回放页共用。
 *
 * 用户要求(2026-09-20):「对手页需要带上玩家名,以及总场次」。
 * 所以这一张表要同时回答四件事:**谁(玩家名) · 玩什么(英雄) · 强不强(英雄强度) ·
 * 他自己的战绩(胜率 + 场次)**。
 *
 * @param entries [{ team:"enemy"|"ally"|"me", champion, player,
 *                   champTier, champWinRate,       // 英雄本身的强度(aramgg)
 *                   ownWinRate, games, wins, losses, kda, lastAt, error, hasStats }]
 *   ⚠ **两个胜率必须分开命名**:`champWinRate` 是"这个英雄强不强",
 *     `ownWinRate` 是"这个人打得怎么样"。早先把两者都叫 winRate,结果表格里
 *     英雄胜率被当成人胜率打了出来(自己看出来的:同一行出现两个 46.83%)。
 */
export function opponentTableText(entries, opts = {}) {
  const list = entries ?? [];
  if (!list.length) return "";
  const now = opts.now ?? Date.now();
  const order = { enemy: 0, ally: 1, me: 2, unknown: 3 };
  const sorted = [...list].sort((a, b) => (order[a.team] ?? 9) - (order[b.team] ?? 9));

  // CJK 是双宽,padEnd 按码点数补不齐 —— 自己按显示宽度补(否则列看起来是歪的)
  const width = (s) => [...String(s ?? "")].reduce((n, ch) => n + (/[\u2E80-\uFE4F\uFF00-\uFFEF]/.test(ch) ? 2 : 1), 0);
  const pad = (s, w) => {
    const t = String(s ?? "");
    return t + " ".repeat(Math.max(0, w - width(t)));
  };

  const lines = [];
  for (const e of sorted) {
    const side = e.team === "enemy" ? "敌" : e.team === "me" ? "我" : e.team === "ally" ? "友" : "?";
    const player = e.player ? String(e.player) : "—";
    const champ = String(e.champion ?? "?");
    const hero = (e.champTier || e.champWinRate !== null && e.champWinRate !== undefined)
      ? `${champ} T${e.champTier ?? "?"} ${e.champWinRate ?? "?"}%`
      : champ;
    let own;
    if (e.hasStats === false || e.games === undefined || e.games === null) {
      // "查不到"与"没打过"要分开说 —— 显示成 0% 会被读成"全败"
      own = e.error ? `查询失败(${e.error})` : "—";
    } else if (!e.games) {
      own = "近期无大乱斗记录";
    } else {
      const gap = agoText(e.lastAt, now);
      own = `${String(e.ownWinRate ?? "?").padStart(3)}% ${String(e.games).padStart(2)}局` + (gap ? ` ${gap}` : "");
    }
    lines.push(`${side} ${pad(player, 22)} ${pad(hero, 18)} ${own}`);
  }
  if (opts.withHead !== false) {
    // 场次口径必须写清楚:国服**没有生涯总场次接口**(lol-career-stats 实测 404),
    // 能拿到的是 match-history 的最近若干局 —— 说成"总场次"就是编数据。
    lines.unshift(`【双方名单 + 近${opts.sample ?? 20}局战绩】玩家名 · 英雄(强度) · 本人胜率/场次`);
  }
  return lines.join("\n");
}

/**
 * 双方**名单**(不含战绩)。**纯函数**,悬浮窗与回放页共用同一份格式。
 *
 * 为什么需要它(用户反馈「模拟回放测试还是看不到对手」):
 *   「对手」页原来只在**查到了胜率**时才有内容 —— 录像里没有战绩(录于功能上线前)
 *   就只剩一句"录于功能上线前",看起来就是**这一页什么都没有**。
 *   但"对手是谁"这件事跟战绩无关:英雄名单一直都在(加载页/选人/Live API)。
 *   所以名单要**独立于战绩**地渲染:有战绩就带上胜率,没有也至少把对手列出来。
 *
 * @param roster { allies:[{champion,tier,winRate}], enemies:[...], me:{} }
 */
export function rosterText(roster, opts = {}) {
  const fmtOne = (c) => {
    const name = c?.champion ?? c?.name ?? "?";
    const t = c?.tier ? ` T${c.tier}` : "";
    const w = c?.winRate !== null && c?.winRate !== undefined ? ` ${c.winRate}%` : "";
    return `${name}${t}${w}`;
  };
  const fmt = (list) => {
    const arr = (list ?? []).map(fmtOne).filter(Boolean);
    return arr.length ? arr.join(" · ") : "（未知）";
  };
  const lines = [];
  const enemies = [...(roster?.enemies ?? [])];
  const allies = [...(roster?.allies ?? [])];
  // 自己也列进我方 —— 否则"我方"看起来少一个人,会让人以为名单缺了
  if (roster?.me?.champion && !allies.some((a) => (a?.champion ?? a?.name) === roster.me.champion)) {
    allies.unshift(roster.me);
  }
  if (enemies.length) lines.push(`敌方: ${fmt(enemies)}`);
  if (allies.length) lines.push(`我方: ${fmt(allies)}`);
  if (opts.withHead !== false && lines.length) {
    lines.unshift(`【双方名单】${roster?.source ? `(${roster.source})` : ""}`.trim());
  }
  return lines.join("\n");
}

/**
 * 把「名单」和「战绩」按人合并成 `opponentTableText` 要的行。**纯函数**。
 *
 * 为什么必须合并而不是两块分开显示:用户要的是"这一行就能看清
 * **谁(玩家名)在玩什么(英雄)、他本人什么水平(胜率+场次)**"。
 * 名单和战绩分两处时,读的人要在脑子里对齐两遍 —— 而两边的英雄名还可能
 * 一个写"伊泽瑞尔"一个写"探险家"。
 *
 * 匹配顺序:puuid(实时最可靠)→ 玩家名(回放的旧录像只有名字)→ 英雄名(最后的兜底)。
 *
 * @param roster  [{ team, champion, player, puuid, tier, winRate }]
 * @param statsBy puuid|player|champion → lookup 结果(Map 或普通对象)
 */
export function mergeOpponentRows(roster, statsBy, opts = {}) {
  const get = (k) => (k === null || k === undefined ? undefined : (statsBy?.get ? statsBy.get(k) : statsBy?.[k]));
  return (roster ?? []).map((r) => {
    const s = get(r.puuid) ?? get(r.player) ?? get(r.champion) ?? null;
    const ok = s && s.ok !== false;
    return {
      team: r.team ?? "unknown",
      champion: r.champion ?? "?",
      player: r.player ?? null,
      champTier: r.tier ?? null,
      champWinRate: r.winRate ?? null,
      ownWinRate: ok ? (s.winRate ?? null) : null,
      games: ok ? (s.games ?? 0) : null,
      wins: ok ? (s.wins ?? 0) : null,
      losses: ok ? (s.losses ?? 0) : null,
      kda: ok ? (s.kda ?? null) : null,
      lastAt: ok ? (s.lastAt ?? null) : null,
      error: s && s.ok === false ? (s.error ?? "查询失败") : null,
      hasStats: !!ok,
      me: !!opts.meKey && (r.puuid === opts.meKey || r.player === opts.meKey),
    };
  });
}

/**
 * 建一个带缓存/限流的查询器。
 *
 * 为什么要缓存:一局里同一批玩家会被反复问到(Live API 每 ~1s 轮询一次),
 * 而每次查询是 1 个本地 HTTP + 20 局数据 —— 不缓存会每秒钟打 10 次。
 *
 * @param request   `(path) => Promise<{status, data}>`:注入以便离线测试
 * @param ttlMs     成功结果缓存时长(默认 15 分钟,一局之内一般够)
 * @param failTtlMs 失败结果缓存时长(默认 3 分钟:别把一次网络抖动记成永远查不到)
 * @param maxGames  取最近多少局(默认 20)
 */
export function createPlayerStats({ request, ttlMs = 15 * 60 * 1000, failTtlMs = 3 * 60 * 1000, maxGames = 20, log = () => {} }) {
  const cache = new Map(); // puuid -> { at, ttl, data }
  const inflight = new Map(); // puuid -> Promise(同一玩家并发查询合流)

  async function fetchOne(puuid) {
    const path = `/lol-match-history/v1/products/lol/${puuid}/matches?begIndex=0&endIndex=${Math.max(0, maxGames - 1)}`;
    let res;
    try {
      res = await request(path);
    } catch (e) {
      return { ok: false, puuid, error: e?.message ?? String(e), games: 0, winRate: null };
    }
    if (!res || res.status !== 200) {
      // 404/403 都要如实报出来:"查不到"和"没打过"是两回事
      return { ok: false, puuid, error: `HTTP ${res?.status ?? "?"}`, games: 0, winRate: null };
    }
    const summary = parseMatchList(res.data, puuid);
    return { ok: true, puuid, ...summary };
  }

  return {
    /** 查一个玩家(带缓存与并发合流)。 */
    async lookup(puuid) {
      if (!puuid) return { ok: false, puuid: null, error: "无 puuid", games: 0, winRate: null };
      const hit = cache.get(puuid);
      if (hit && Date.now() - hit.at < hit.ttl) return hit.data;
      const running = inflight.get(puuid);
      if (running) return running;
      const p = fetchOne(puuid).then((data) => {
        cache.set(puuid, { at: Date.now(), ttl: data.ok ? ttlMs : failTtlMs, data });
        inflight.delete(puuid);
        if (!data.ok) log(`玩家战绩查询失败 ${String(puuid).slice(0, 8)}…: ${data.error}`);
        return data;
      }).catch((e) => {
        inflight.delete(puuid);
        return { ok: false, puuid, error: e?.message ?? String(e), games: 0, winRate: null };
      });
      inflight.set(puuid, p);
      return p;
    },
    /** 批量查(串行发起,避免一次性压 10 个请求给客户端)。 */
    async lookupMany(puuids, { onEach } = {}) {
      const out = [];
      for (const pu of puuids ?? []) {
        const r = await this.lookup(pu);
        out.push(r);
        if (onEach) { try { onEach(r); } catch { /* 回调失败不影响查询 */ } }
      }
      return out;
    },
    cache: {
      size: () => cache.size,
      clear: () => { cache.clear(); inflight.clear(); },
    },
  };
}

/**
 * 把"这一局的十个人"和查到的战绩合并成悬浮窗要的行。**纯函数**。
 * @param players [{ puuid, champion, team, riotId }]  team: "ally"|"enemy"
 * @param stats   puuid → lookup 结果
 * @param opts.mePuuid 我自己的 puuid(标成"我")
 */
export function buildRows(players, stats, opts = {}) {
  const rows = [];
  for (const p of players ?? []) {
    const s = stats?.[p.puuid] ?? stats?.get?.(p.puuid) ?? null;
    rows.push({
      puuid: p.puuid,
      riotId: p.riotId ?? null,
      champion: p.champion ?? "?",
      team: p.puuid && p.puuid === opts.mePuuid ? "me" : (p.team ?? "unknown"),
      games: s?.games ?? 0,
      wins: s?.wins ?? 0,
      losses: s?.losses ?? 0,
      winRate: s && s.ok !== false ? (s.winRate ?? null) : null,
      kda: s?.kda ?? null,
      lastAt: s?.lastAt ?? null,
      error: s && s.ok === false ? (s.error ?? "查询失败") : null,
    });
  }
  return rows;
}
