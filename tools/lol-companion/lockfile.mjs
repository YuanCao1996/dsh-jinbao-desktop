// lockfile.mjs — 获取 LCU(Local Client API)凭据
// ----------
// LCU 是客户端自己开的本地 HTTPS 服务,端口与口令每次都随机。两条获取途径:
//
// ① 国际服:Riot 把凭据写在 lockfile 里(冒号分隔 5 段)
//      <进程名>:<pid>:<端口>:<口令>:<协议>   例 LeagueClient:12345:52341:aBcD...:https
// ② **国服 WeGame/Tencent 实测:lockfile 恒为 0 字节(不写)**,
//    但启动 LeagueClientUx.exe 时把 --app-port / --remoting-auth-token 直接放在**命令行**上:
//      LeagueClientUx.exe ... "--remoting-auth-token=XXXX" "--app-port=51479" --app-pid=35980 --region=TENCENT
//    所以必须支持命令行兜底,否则国服一条数据都拿不到(2026-09-13 真机验证)。
//
// 对外入口用 readCredentials():先试 lockfile(PID 存活优选),失败再试命令行。
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

/** 候选 lockfile 路径(按优先级)。可用 LOL_INSTALL_DIR 环境变量覆盖安装根目录。 */
export function candidateLockfiles() {
  const roots = [];
  if (process.env.LOL_INSTALL_DIR) roots.push(process.env.LOL_INSTALL_DIR);
  roots.push(
    "D:\\Games\\WeGameApps\\英雄联盟",
    "C:\\Program Files\\WeGameApps\\英雄联盟",
    "C:\\Games\\英雄联盟",
    "C:\\Riot Games\\League of Legends",
    "D:\\Riot Games\\League of Legends"
  );
  const extra = [
    join("LeagueClient", "lockfile"),
    join("Riot Client Data", "User Data", "Config", "lockfile"),
  ];
  const out = [];
  for (const r of roots) for (const e of extra) out.push(join(r, e));
  // 允许直接指定 lockfile
  if (process.env.LOL_LOCKFILE) out.unshift(process.env.LOL_LOCKFILE);
  return out;
}

/**
 * 找并解析 lockfile。
 * 客户端退出后 lockfile 会**残留**(甚至空文件),而 Riot Client 也有一份自己的
 * lockfile。所以不能"第一个能读的就算数":要按 **PID 是否存活** 优选,再看路径优先级。
 * @returns {{ok:true, path, processName, pid, port, password, protocol, baseUrl, auth}
 *          | {ok:false, reason, checked, stale?}}
 */
export function readLockfile() {
  const checked = [];
  const parsed = [];
  for (const p of candidateLockfiles()) {
    checked.push(p);
    if (!existsSync(p)) continue;
    let text = "";
    try {
      text = readFileSync(p, "utf8").trim();
    } catch {
      // 客户端刚写入时可能被独占 → 记为候选但无内容
      continue;
    }
    if (!text) continue; // 空文件 = 上次运行留下的残渣
    const parts = text.split(":");
    if (parts.length < 5) continue;
    const [processName, pid, port, password, protocol] = parts;
    parsed.push({
      path: p, processName,
      pid: Number(pid), port: Number(port), password, protocol,
      baseUrl: `${protocol}://127.0.0.1:${port}`,
      auth: "Basic " + Buffer.from(`riot:${password}`, "utf8").toString("base64"),
      alive: isPidAlive(Number(pid)),
    });
  }
  if (parsed.length === 0) {
    return { ok: false, reason: "未找到有效的 lockfile(客户端未运行?)", checked };
  }
  // 优先:进程存活 → 原始候选顺序(LeagueClient 排在 Riot Client 之前)
  const best = parsed.find((c) => c.alive) ?? parsed[0];
  const { alive, ...rest } = best;
  return { ok: true, alive, ...rest, stale: !alive, all: parsed.map(({ auth, ...c }) => c) };
}

/** 进程是否存活(用 tasklist 精确查 PID)。 */
function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: "latin1", timeout: 4000 });
    return new RegExp(`\\b${pid}\\b`).test(out) && !/No tasks/i.test(out);
  } catch {
    return false;
  }
}

// #region 国服兜底:从 LeagueClientUx.exe 命令行读凭据
let cmdlineCache = { at: 0, value: null };
const CMDLINE_CACHE_MS = 10000;

/**
 * 国服兜底:从 LeagueClientUx.exe 的**命令行**取 LCU 端口与口令。
 * 客户端把这两个值作为启动参数传给自己(`--app-port` / `--remoting-auth-token`),
 * 因此即使 lockfile 是空的也能连上。带 10s 缓存,避免断线重连时反复查 WMI。
 * @returns {{ok:true, source:'cmdline', port, password, pid, region, baseUrl, auth, alive}
 *          | {ok:false, reason}}
 */
export function readCmdlineCredentials() {
  const now = Date.now();
  if (cmdlineCache.value && now - cmdlineCache.at < CMDLINE_CACHE_MS) return cmdlineCache.value;
  let out = "";
  try {
    out = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'LeagueClientUx.exe\'\\" | Select-Object -ExpandProperty CommandLine"',
      { encoding: "utf8", timeout: 12000, windowsHide: true }
    );
  } catch (e) {
    const r = { ok: false, reason: `读取 LeagueClientUx 命令行失败: ${e.message}` };
    cmdlineCache = { at: now, value: r };
    return r;
  }
  const port = /--app-port=(\d+)/.exec(out)?.[1];
  const token = /--remoting-auth-token=([\w-]+)/.exec(out)?.[1];
  const pid = /--app-pid=(\d+)/.exec(out)?.[1];
  const region = /--region=([\w]+)/.exec(out)?.[1];
  if (!port || !token) {
    const r = { ok: false, reason: "LeagueClientUx 命令行里没有 --app-port / --remoting-auth-token(客户端未运行?)" };
    cmdlineCache = { at: now, value: r };
    return r;
  }
  const r = {
    ok: true, source: "cmdline", processName: "LeagueClientUx",
    port: Number(port), password: token, pid: Number(pid) || null, region: region ?? null,
    protocol: "https", baseUrl: `https://127.0.0.1:${port}`,
    auth: "Basic " + Buffer.from(`riot:${token}`, "utf8").toString("base64"),
    alive: pid ? isPidAlive(Number(pid)) : true,
  };
  cmdlineCache = { at: now, value: r };
  return r;
}

/**
 * 按**可靠性排序**给出所有可用凭据,调用方逐个探测直到某个能通过 LCU ping。
 *
 * 顺序刻意如此(2026-09-13 真机踩坑后确定):
 *   1) LeagueClientUx.exe 命令行 —— 明确属于英雄联盟客户端,国服/国际服都适用;
 *   2) lockfile 且 processName 像 League —— 国际服标准;
 *   3) 其它 lockfile(如 Riot Client)—— **兜底放最后**:RiotClientServices 的 lockfile
 *      同样存在且 PID 存活,但它的 API 面不是英雄联盟的,拿去请求会得到 404。
 *      早期只看"PID 存活",结果选中 Riot Client 的凭据,LCU 直接 404。
 */
export function credentialCandidates() {
  const out = [];
  const cl = readCmdlineCredentials();
  if (cl.ok) out.push(cl);
  const lf = readLockfile();
  if (lf.ok) {
    const entry = { ...lf, source: "lockfile" };
    if (/league/i.test(lf.processName ?? "")) out.unshift(entry); // 明确是 LoL 客户端 → 最优先
    else out.push(entry);                                          // 可能是 Riot Client → 兜底
  }
  return out;
}

/**
 * 统一的凭据入口(取排序后的第一个)。需要容错时请用 credentialCandidates() 逐个试。
 */
export function readCredentials() {
  const list = credentialCandidates();
  if (list.length) return list[0];
  const lf = readLockfile();
  return { ...lf, reason: lf.reason ?? "未找到可用凭据(客户端未运行?)" };
}
// #endregion

/** 判断客户端进程是否在跑(不依赖 lockfile)。 */
export function clientProcessRunning() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq LeagueClientUx.exe" /NH', { encoding: "latin1" });
    return /LeagueClientUx\.exe/i.test(out);
  } catch {
    return false;
  }
}
