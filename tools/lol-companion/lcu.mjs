// lcu.mjs — LCU(League Client Update)本地 API 客户端
// ----------
// 客户端自带的本地 HTTPS 服务,用 lockfile 里的端口 + Basic(riot:<password>)访问,
// 证书是自签的 → rejectUnauthorized:false。只读,不碰游戏进程,不越反作弊边界。
//
// 常用端点(海克斯大乱斗/ARAM 需要的):
//   GET /lol-gameflow/v1/gameflow-phase              → 当前阶段字符串
//   GET /lol-champ-select/v1/session                 → 选人会话(我的英雄/双方阵容/备选席)
//   GET /lol-summoner/v1/current-summoner            → 我的召唤师
//   GET /lol-gameflow/v1/session                     → 对局会话(含 queueId → 判断模式)
//   GET /lol-chat/v1/me                              → 当前玩家昵称
import https from "node:https";

/**
 * 对 LCU 发一次请求。
 * @param {{baseUrl:string, auth:string}} lcu
 * @param {string} path 以 / 开头的端点
 * @param {{method?:string, body?:any, timeoutMs?:number}} opts
 * @returns {Promise<{status:number, data:any}>} data 为解析后的 JSON(非 JSON 则为原文)
 */
export function lcuRequest(lcu, path, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const payload = opts.body === undefined ? null : Buffer.from(JSON.stringify(opts.body), "utf8");
  const headers = { authorization: lcu.auth, accept: "application/json" };
  if (payload) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(payload.length);
  }
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: "127.0.0.1", port: lcu.port, path, method: opts.method ?? "GET", headers, rejectUnauthorized: false, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data = text;
          try { data = text ? JSON.parse(text) : null; } catch { /* 保留原文 */ }
          resolve({ status: res.statusCode ?? 0, data });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`LCU 请求超时(${timeoutMs}ms): ${path}`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 便捷:GET 并返回 data;失败返回 null(调用方按"客户端不可用"处理)。 */
export async function lcuGet(lcu, path, opts = {}) {
  try {
    const r = await lcuRequest(lcu, path, opts);
    return r.status >= 200 && r.status < 300 ? r.data : null;
  } catch {
    return null;
  }
}

/** 连通性探测:拿当前召唤师(同时验证口令有效)。 */
export async function lcuPing(lcu) {
  const t0 = Date.now();
  try {
    const r = await lcuRequest(lcu, "/lol-summoner/v1/current-summoner", { timeoutMs: 3000 });
    return { ok: r.status === 200, status: r.status, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, error: e.message };
  }
}

/** 当前游戏阶段。 */
export const getPhase = (lcu) => lcuGet(lcu, "/lol-gameflow/v1/gameflow-phase");

/** 选人会话(非选人阶段返回 null)。 */
export const getChampSelect = (lcu) => lcuGet(lcu, "/lol-champ-select/v1/session");

/** 对局会话(含 queueId / 模式名)。 */
export const getGameflowSession = (lcu) => lcuGet(lcu, "/lol-gameflow/v1/session");

/** 我的召唤师信息。 */
export const getMySummoner = (lcu) => lcuGet(lcu, "/lol-summoner/v1/current-summoner");

/** 我的对局段位/统计(可能为 null)。 */
export const getMyRankedStats = (lcu) => lcuGet(lcu, "/lol-ranked/v1/current-ranked-stats");

/** 英雄 id → 名称映射(LCU 自带,避免依赖网络)。 */
export const getChampionSummary = (lcu) => lcuGet(lcu, "/lol-game-data/assets/v1/champion-summary.json", { timeoutMs: 8000 });
