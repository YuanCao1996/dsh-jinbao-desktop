// dsh-coach-server
// ----------
// 金宝游戏教练的 DSH 后端插件。App 通过 HTTP 调用,DSH 提供"大脑":
//
//   POST /ai/generate   快/深双速路由:
//                        - 快路径(局内互动/系统通知):ctx.llm 直连快模型,<2s,无记忆
//                        - 深路径(经济面板/死亡回放/战绩/攻略):走 DSH agent 会话
//                          coach-{matchId},每局一个 session(真实记忆),agent 可用
//                          site_query(本地真实数据)+ web_search(联网),回复经 agent
//                          会话内注册的 coach_reply 工具回传
//   GET  /health        健康检查
//   POST /tts/token, /realtime/token, /vision/analyze, /vision/ocr
//                        透传到上游(默认 https://api.jinbaoai.top),感知层不动
//
// 契约(与 App 实际调用对齐):请求 {prompt, model, system_prompt, ...};
// 响应 {"response": 播报文本}(空串 = App 静音,与现状一致)。
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync, readdirSync, rmSync, writeFileSync, appendFileSync, mkdirSync, statSync, renameSync } from "node:fs";
import { join as joinPath, basename } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { SessionPreparation } from "@deepseek-ai/dsh-session";
// logstream 只提供游戏无关的 tailer/落盘;日志解析与过滤规则来自 game adapter。
import { createTailer, appendBroadcast } from "./logstream.js";
import { createGameRegistry, WZRY_ADAPTER, LOL_ADAPTER } from "./game-registry.js";
import { SseStream, sseHeaders } from "./sse.js";
import { createVision } from "./vision.js";

const name = "coach-server";
const inject = ["tools", "systemPrompt", "llm", "agentLoop", "sessions", "web"];

// 自建 web_search provider(opencode 网关检索):DSH 默认 web-search-deepseek 依赖
// DeepSeek 官方 key(已失效);这里用 Bing RSS(免 key)直接检索真实结果。
// 注册 id = OPENCODE_SEARCH_PROVIDER_ID;要让 web 工具选它,需把 dsh-web 的
// searchProvider 配置改为该 id(见 cordis.patch.yml)。
const OPENCODE_SEARCH_PROVIDER_ID = "opencode-go-search";
const BING_RSS_URL = "https://www.bing.com/search?format=rss&q=";
const SEARCH_MAX_RESULTS_DEFAULT = 6;
const SEARCH_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

const DEFAULT_PORT = 3081;
const DEFAULT_UPSTREAM = "https://api.jinbaoai.top";
const DEFAULT_PROVIDER = "opencode-go";
const DEFAULT_MODEL = "deepseek-v4-flash";
const FAST_TIMEOUT_MS = 2000;
const DEEP_TIMEOUT_MS = 10000;
const IDLE_SESSION_MS = 10 * 60 * 1000; // 10 分钟无请求视为新对局
const DEFAULT_WATCH_DIR = joinPath(homedir(), ".dsh", "jinbao", "logs");
const DEFAULT_BROADCAST_FILE = joinPath(homedir(), ".dsh", "jinbao", "logs", "coach_broadcasts.jsonl");
/** 诊断日志文件(同步追加)。
 *
 *  为什么不能只靠 console:DSH 用 `-RedirectStandardOutput` 把 stdout 接到文件时,
 *  Node 的 stdout 是**带缓冲**的 —— 实测 dsh-web.log 从进程启动那一刻起就再没长过,
 *  于是"教练为什么不说话"这类关键警告**永远不会落盘**。这正是对局 m20260919143955
 *  里 134 个回合静默消失却查不出原因的直接原因之一。
 *  这里用 appendFileSync 写一条同步的旁路:实时可读、进程被杀也不丢。 */
const DIAG_LOG_FILE = joinPath(homedir(), ".dsh", "jinbao", "coach-server.log");
const DIAG_LOG_MAX_BYTES = 4 * 1024 * 1024; // 超过就轮转一次(.1),避免无限增长
let diagCheckedAt = 0;
/** @param {string} message @param {{diagLogFile?: string}} [cfg] —— 路径可配,便于测试指向临时文件 */
function diagLog(message, cfg) {
  const file = cfg?.diagLogFile ?? DIAG_LOG_FILE;
  const line = `[${new Date().toLocaleString("zh-CN", { hour12: false })}] ${message}\n`;
  try {
    mkdirSync(joinPath(file, ".."), { recursive: true });
    // 轮转:最多每 5 分钟 stat 一次(诊断日志不该拖慢主链路)
    if (Date.now() - diagCheckedAt > 5 * 60 * 1000) {
      diagCheckedAt = Date.now();
      if (statSync(file, { throwIfNoEntry: false })?.size > DIAG_LOG_MAX_BYTES) {
        renameSync(file, `${file}.1`);
      }
    }
    appendFileSync(file, line, "utf8");
  } catch { /* 诊断日志失败绝不影响主链路 */ }
}

const Config = z.object({
  port: z.number().default(DEFAULT_PORT),
  upstream: z.string().default(DEFAULT_UPSTREAM),
  provider: z.string().default(DEFAULT_PROVIDER),
  model: z.string().default(DEFAULT_MODEL),
  fastTimeoutMs: z.number().default(FAST_TIMEOUT_MS),
  deepTimeoutMs: z.number().default(DEEP_TIMEOUT_MS),
  idleSessionMs: z.number().default(IDLE_SESSION_MS),
  watchDir: z.string().default(DEFAULT_WATCH_DIR),
  broadcastFile: z.string().default(DEFAULT_BROADCAST_FILE),
  watchEnabled: z.boolean().default(true),
  watchPollMs: z.number().default(2000),
  watchStartDelayMs: z.number().default(5000),
  watchReplay: z.boolean().default(false),
  watchReplaySpeed: z.number().default(1),
  // 诊断日志文件(同步追加)。默认 D:/work/DSH/workspace/coach-server.log。
  // 为什么需要它而不只用 console:DSH 用 -RedirectStandardOutput 把 stdout 接到文件时,
  // Node 的 stdout 是带缓冲的 —— 实测 dsh-web.log 自进程启动后再没长过,
  // 关键警告永远不落盘(对局 m20260919143955 查不出原因的直接原因之一)。
  diagLogFile: z.string().default(DIAG_LOG_FILE),
  logstreamTimeoutMs: z.number().default(15000),
  sessionCwd: z.string().default(joinPath(homedir(), ".dsh", "jinbao")),
  coachPreset: z.string().default("game-assistant"),
  defaultGame: z.string().default("wzry"), // 日志流/监控会话默认使用的游戏 adapter
  // 日志流监控会话(coach-live)单回合超时。与 deepTimeoutMs 分开:监控会话长生命周期,
  // 首回合冷启动实测 >20s(王者/端游都一样),用统一 20s 会把首条播报切成静音。
  liveTimeoutMs: z.number().default(45000),
  // coach-live 会话启动看门狗:createAgent 既不 resolve 也不 reject 时(实测:preset
  // mount 卡住),旧实现让队列无限增长且毫无痕迹 —— 到点即判定失败并拒绝队列。
  monitorStartTimeoutMs: z.number().default(90000),
  // 失败后的自动重建冷却。冷却期一过,下一条事件会重建会话(自愈),
  // 而不是让整个 DSH 生命周期内所有回合永久静默。
  monitorRetryCooldownMs: z.number().default(30000),
  maxToolSteps: z.number().default(15), // SSE 流式(Phase 2):agent 回合内工具调用上限,防死循环
  // ── 画面理解兜底(多模态模型看截图)──────────────────────────────
  // 本地 OCR 读不出来的场景(游戏/模式/阶段/我是谁/双方阵容)交给模型看图回答。
  // 默认开启,但只在**本地识别失败或存疑**时才触发(见 companion 的调用点),
  // 不是每帧都问 —— 那是每局几百次云端调用。
  visionEnabled: z.boolean().default(true),
  // 看一张图要十几秒(模型要推理整屏语义),给足;超时按失败处理,回退本地结论。
  visionTimeoutMs: z.number().default(20000),
});

//#region 分类(快/深)
function isDeepRequest(body, adapter) {
  const keywords = (adapter?.deepKeywords ?? WZRY_ADAPTER.deepKeywords);
  const systemPrompt = typeof body.system_prompt === "string" ? body.system_prompt : "";
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (keywords.some((k) => systemPrompt.includes(k) || prompt.includes(k))) return true;
  if (systemPrompt.length > 2000) return true;
  if (prompt.includes("json") || prompt.includes("JSON") || prompt.includes("输出JSON")) return true;
  return false;
}
//#endregion

//#region LLM 直连(快路径)
async function directLlmText(ctx, cfg, messages, signal, timeoutMs, opts = {}) {
  // opencode 网关(opencode-go)不支持 reasoningEffort 参数(实测 400/拒绝);
  // 其它 provider(deepseek-official 等)仍可传。按 provider 过滤,避免快路径报错。
  const provider = cfg.provider;
  const supportsReasoningEffort = !["opencode-go", "jinbao-local"].includes(provider);
  const config = {
    provider,
    model: cfg.model,
    messages,
    maxTokens: opts.maxTokens ?? 2000,
    ...(supportsReasoningEffort && opts.reasoningEffort !== undefined ? { reasoningEffort: opts.reasoningEffort } : {})
  };
  let call;
  try {
    call = await ctx.llm.prepareCall(config, signal);
  } catch (error) {
    console.warn(`[coach-server] llm prepareCall failed: ${error?.message ?? error}`);
    throw error;
  }
  let text = "";
  let deltas = 0;
  try {
    for await (const chunk of call.stream(call.config)) {
      if (chunk.type === "text-delta") {
        deltas += 1;
        text += chunk.text;
      }
    }
  } catch (error) {
    console.warn(`[coach-server] llm stream error: ${error?.message ?? error}`);
    throw error;
  }
  console.log(`[coach-server] llm call done provider=${cfg.provider} model=${cfg.model} deltas=${deltas} chars=${text.trim().length}`);
  return text.trim();
}

function fastReply(ctx, cfg, body, signal, timeoutMs = cfg.fastTimeoutMs) {
  return withTimeout(
    async () => {
      const systemPrompt = typeof body.system_prompt === "string" ? body.system_prompt : "";
      const prompt = typeof body.prompt === "string" ? body.prompt : "";
      const text = await directLlmText(ctx, cfg, [
        systemPrompt ? { role: "system", content: [{ type: "text", text: systemPrompt }] } : null,
        { role: "user", content: [{ type: "text", text: prompt }] }
      ].filter(Boolean), signal, timeoutMs, { reasoningEffort: "low" });
      return { response: text };
    },
    timeoutMs,
    () => ({ response: "" })
  );
}

/** 日志流专用:宽松预算 + 空结果重试一次(冷启动兜底,无时延压力) */
async function logstreamReply(ctx, cfg, body, matchId) {
  const deep = isDeepRequest(body);
  const signal = AbortSignal.timeout(20000);
  const produce = async () => {
    const result = deep
      ? await deepReply(ctx, cfg, body, matchId, signal)
      : await fastReply(ctx, cfg, body, signal, cfg.logstreamTimeoutMs ?? 15000);
    return result?.response ?? "";
  };
  let text = await produce();
  if (!text) text = await produce(); // 冷启动首次可能超时,重试一次
  return text;
}
//#endregion

//#region 深路径(agent 会话)
function buildCoachMessage(body, adapter) {
  const systemPrompt = typeof body.system_prompt === "string" ? body.system_prompt : "";
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const persona = adapter?.persona ?? WZRY_ADAPTER.persona;
  const maxReplyTokens = persona.maxReplyTokens ?? 50;
  return [
    "【金宝教练请求 — 请处理并播报】",
    "",
    "## 应用传入的系统提示词(人设,必须保持)",
    systemPrompt || "(无)",
    "",
    "## 应用传入的请求内容",
    prompt,
    "",
    "## 你的任务",
    "结合请求内容与已有对局记忆,决定是否需要查询数据(site_query 查英雄/胜率/梯度等本地真实数据,web_search 查版本/新套路/冷知识),然后给出最终播报文本。",
    "",
    "## 硬性规则",
    `- 保持传入人设的口吻,≤${maxReplyTokens}字,单句,口语化,无markdown,不提工具/联网/DSH`,
    "- 纯系统噪音消息(如“互动内容由AI生成”)→ 输出空字符串",
    "- 结论只能来自输入事实、对局记忆或查询到的数据,不得凭空编造数值",
    "- 调用 coach_reply 一次性输出最终播报文本:调用即结束,调用后立即停止,不要再输出文字、不要再调其他工具、不要再次调用 coach_reply"
  ].join("\n");
}

/**
 * 回合终止守卫(2026-09 修复 #2):coach_reply 一旦提交,同一回合的后续 step 直接
 * `reject`。模型收到 coach_reply 的 tool result 后总会再跑一个 step,输出
 * "播报完成。/静默。/一段解释"这类确认文本 —— 旧日志里 39/91 个 step 全是这种纯浪费
 * (每次都是一轮完整 LLM 往返,还把确认文本写进会话继续撑大上下文)。
 *
 * 安全性:只在"该 step 没有任何真实新输入(空消息、或全部是工具结果)"时拒绝,
 * 因此不会丢用户新消息(steer/inject 进来的输入会正常放行)。
 * 工具结果本身由 agent-loop 的 appendToolResult 独立持久化,拒绝 step 不会丢数据。
 *
 * @param {object} agentCtx 该 agent 的作用域 context(agent/pre-step 是 agent 级作用域)
 * @param {{replied:boolean}} state 与本 agent 的 coach_reply 工具共享的回合状态
 */
function installReplyStepGuard(agentCtx, state) {
  agentCtx.on("agent/pre-step", (payload, next) => {
    if (payload?.step === 1) state.replied = false; // 新回合开始,复位
    if (!state.replied) return next();
    const msgs = payload?.messages ?? [];
    const noFreshInput = msgs.length === 0 || msgs.every((m) => m?.source?.kind === "tool");
    if (!noFreshInput) return next(); // 有真实新输入 → 正常进入
    return { kind: "reject" }; // 纯 coach_reply 的收尾 step → 结束回合,省掉一次 LLM 调用
  });
  return state;
}

/**
 * 捕获本 agent 回合内最后一条 assistant 文本(2026-09 修复 #4 的观测/兜底用)。
 * 用 session/event 事件流(agent 作用域),只取 text block。
 */
function installAssistantTextTap(agentCtx, sink, cfg) {
  try { sink.__diagCfg = cfg; } catch {}
  agentCtx.on("session/event", (_session, event) => {
    // ── 埋点:回合内每条会话事件都记一行(type + 前 90 字) ──
    //   找的是"提问回合 0.1 秒就 idle"那 100ms 里 agent 到底干了什么:
    //   是 assistant/message(模型回了)、还是 error/reject/别的。
    try {
      const _et = event?.type ?? "?";
      const _ed = JSON.stringify(event?.data ?? {})?.slice(0, 90) ?? "";
      diagLog(`   [sess] ${_et} ${_ed}`, sink.__diagCfg);
    } catch { /* 埋点不影响主链路 */ }
    if (!event || event.type !== "assistant/message") return;
    const blocks = event.data?.message?.content ?? [];
    const text = blocks
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("")
      .trim();
    if (text) sink.lastText = text;
  });
}

function makeCoachReplyTool(entry, adapter, replyState) {
  const persona = adapter?.persona ?? WZRY_ADAPTER.persona;
  return defineTool({
    name: "coach_reply",
    // ⚠ 两种模式(2026-10-01):用户可能在**会话里直接提问**(没有挂起的播报请求)。
    //   那种情况下不要死守"≤50字播报" —— 正常展开回答,再用本工具给出结论。
    description: (persona.replyDescription ?? "输出本次教练请求的最终播报文本(≤50字)。调用后本次请求即完成。")
      + " 注意:如果这一轮是**用户在会话里直接提问**(不是对局事件触发的播报),"
      + "请先展开回答,再用本工具提交结论;此时文本不会截断成播报,会原样显示给用户。",
    parameters: {
      text: { type: "string", required: true, description: persona.replyParamDescription ?? "最终播报文本,可为空字符串(表示静音)" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          // 无挂起请求时,回答正文从这里回显(见 execute 的说明)
          // ⚠ 不要写 `required: false` —— 这个方言要求 required 为 true 或不写,
          //   写 false 会让 createAgent 直接失败(unsupported JSON schema),
          //   表现为"coach-live 会话建不出来 → 侧边栏什么都没有"(2026-10-02 实测)。
          text: { type: "string" }
        }
      },
      // ⚠ 原来固定渲染「播报已提交。」—— 用户在会话里提问时会看到一句"已提交"
      //   却**没有内容**,像是教练没回答。有 text 就显示它。
      render: (_a, v) => [{ type: "text", text: (v && v.text) ? v.text : "播报已提交。" }]
    },
    timeoutMs: 5000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const text = typeof args.text === "string" ? args.text : "";
      // 修复 #3:幂等 —— 同一回合重复调用直接忽略(旧日志有 10 个回合调 2-3 次)
      if (replyState) {
        if (replyState.replied) {
          console.warn(`[coach-server] coach_reply called again in the same turn; ignoring duplicate`);
          return { ok: true };
        }
        replyState.replied = true;
      }
      // ⚠ 先记下"有没有人在等这条播报" —— resolvePending 会把 pending 清空,之后就问不出来
      const hadPending = entry.pending.size > 0;
      entry.resolvePending(text);
      // SSE 流式(Phase 2):通知所有订阅该回复的 stream(推 speaking/done 帧)
      if (entry.onReply && entry.onReply.size > 0) {
        for (const cb of [...entry.onReply]) {
          try { cb(text); } catch { /* 单订阅者失败不影响其他 */ }
        }
      }
      // ⚠ 没有挂起请求 = 用户在会话里**直接提问**。resolvePending 此时空转、
      //   文本会被丢弃,而用户只看到「播报已提交。」→ 把正文从工具结果回显出去。
      return hadPending ? { ok: true } : { ok: true, text };
    }
  });
}

function deepReply(ctx, cfg, body, matchId, signal, adapter) {
  const entry = coachRegistry.ensure(ctx, cfg, matchId, adapter);
  const turnId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve, reject) => {
    entry.pending.set(turnId, { resolve, reject, timer: null, sentAt: Date.now() });
    const timer = setTimeout(() => {
      entry.pending.delete(turnId);
      reject(new Error("deep path timeout"));
    }, cfg.deepTimeoutMs);
    entry.pending.get(turnId).timer = timer;
    entry.ready.then(() => {
      const p = entry.agent.send(
        { id: randomUUID(), role: "user", content: [{ type: "text", text: buildCoachMessage(body, adapter) }], source: { kind: "user" } },
        "next-turn",
        true
      );
      if (p && typeof p.catch === "function") {
        p.catch((error) => {
          clearTimeout(timer);
          entry.pending.delete(turnId);
          reject(error);
        });
      }
    }).catch((error) => {
      clearTimeout(timer);
      entry.pending.delete(turnId);
      reject(error);
    });
  }).catch((error) => {
    console.warn(`[coach-server] deep path error: ${error?.message ?? error}`);
    return { response: "" };
  });
}

/**
 * SSE 流式深路径(Phase 2):与 deepReply 同一条 agent 会话,但把回合过程流化成
 * SSE 信封(phase/tool/custom/done/error/cancel)。健壮性:max_tool_steps 防死循环,
 * agent.cancel() 支持 interrupt(由 /coach/control 或 SSE 连接断开触发)。
 *
 * 帧序列:phase(thinking) → [tool(每次工具调用)]* → phase(speaking, text) → done | error | cancel
 *
 * @param {SseStream} sse 已就绪的 SSE 输出端(seq/缓冲由它维护)
 * @param {object} opts { maxToolSteps, onCancel } —— onCancel 是 SSE 连接断开时的中断回调
 * @returns {Promise<{response:string, toolSteps:number, cancelled?:boolean}|null>}
 */
// 被 interrupt(/coach/control)显式中断的 matchId;streamDeepReply 据此推 cancel 帧而非空 done
const interruptedMatchIds = new Set();
function streamDeepReply(ctx, cfg, body, matchId, signal, adapter, sse, opts = {}) {
  const entry = coachRegistry.ensure(ctx, cfg, matchId, adapter);
  const maxToolSteps = opts.maxToolSteps ?? cfg.maxToolSteps ?? 15;
  const agent = () => entry.agent;

  return new Promise((resolve, reject) => {
    let settled = false;
    let toolSteps = 0;
    let cancelled = false;
    let timer = null;
    let pollTimer = null;
    let offTools = null;
    let offStatus = null;

    const cleanup = () => {
      if (offTools) { try { offTools(); } catch { /* noop */ } offTools = null; }
      if (offStatus) { try { offStatus(); } catch { /* noop */ } offStatus = null; }
      entry.onReply.delete(onReply);
      if (timer) { clearTimeout(timer); timer = null; }
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    };

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };

    // ── 工具调用监听(tools/result 是 scope-filtered,host 层需按 agent 过滤)──
    offTools = ctx.on("tools/result", (exec, result) => {
      const ag = agent();
      if (!ag || !exec || exec.agent !== ag) return;
      toolSteps += 1;
      const name = typeof exec.name === "string" ? exec.name : (exec.tool ?? "tool");
      // 只推有意义的工具帧(不推 coach_reply 本身——它是结束信号,走 speaking 帧)
      if (name !== "coach_reply") {
        sse.push("tool", { name, arguments: exec.arguments ?? exec.args ?? null, step: toolSteps });
      }
      // max_tool_steps:超限即中断回合(防死循环)
      if (toolSteps >= maxToolSteps && !cancelled) {
        cancelled = true;
        console.warn(`[coach-server] stream max_tool_steps reached (${maxToolSteps}) for ${matchId}; cancelling agent turn`);
        try { ag.cancel(new Error(`max_tool_steps exceeded (${maxToolSteps})`)); } catch { /* noop */ }
        sse.push("error", { message: `max_tool_steps exceeded (${maxToolSteps})` });
        settle(reject, new Error(`max_tool_steps exceeded (${maxToolSteps})`));
      }
    });

    // agent/status 监听:目前仅用于日志(回合结束由轮询 + onReply 判定)
    offStatus = ctx.on("agent/status", ({ agent: ag, status }) => {
      if (!ag || ag !== agent()) return;
    });

    // ── coach_reply 回传 → speaking + done ──
    const onReply = (text) => {
      if (cancelled) return;
      sse.push("phase", { name: "speaking", text: text ?? "" });
      sse.push("done", { response: text ?? "" });
      settle(resolve, { response: text ?? "", toolSteps, cancelled: false });
    };
    entry.onReply.add(onReply);

    // 启动回合
    const deadline = Date.now() + (cfg.deepTimeoutMs ?? 20000) + 5000;
    const start = async () => {
      const ag = agent();
      if (!ag) throw new Error("agent not ready");
      sse.push("phase", { name: "collecting" });
      sse.push("phase", { name: "thinking" });
      // 轮询:等 send 进入 running,再等回 idle(turn 结束,coach_reply 已触发 onReply)
      let phase = "waiting-run";
      pollTimer = setInterval(() => {
        if (settled) return;
        if (Date.now() > deadline) {
          settle(reject, new Error("SSE stream turn timeout"));
          sse.push("error", { message: "stream turn timeout" });
          return;
        }
        const s = ag.status;
        if (phase === "waiting-run") {
          if (s === "running") phase = "waiting-idle";
        } else if (phase === "waiting-idle") {
          if (s === "idle" && !settled) {
            // agent 回合结束但没调 coach_reply:若被 interrupt 显式中断 → 推 cancel;
            // 否则按异常/空播报结束(推 done 空)。
            if (interruptedMatchIds.has(matchId)) {
              interruptedMatchIds.delete(matchId);
              sse.push("cancel", { message: "interrupted" });
              settle(resolve, { response: "", toolSteps, cancelled: true });
              return;
            }
            sse.push("done", { response: "" });
            settle(resolve, { response: "", toolSteps, cancelled: false });
          }
        }
      }, 100);

      timer = setTimeout(() => {
        if (!settled) {
          try { ag.cancel(new Error("stream timeout")); } catch { /* noop */ }
          sse.push("error", { message: "stream timeout" });
          settle(reject, new Error("stream timeout"));
        }
      }, deadline - Date.now() + 100);

      try {
        ag.send(
          { id: randomUUID(), role: "user", content: [{ type: "text", text: buildCoachMessage(body, adapter) }], source: { kind: "user" } },
          "next-turn",
          true
        );
      } catch (error) {
        sse.push("error", { message: error?.message ?? String(error) });
        settle(reject, error);
      }
    };

    entry.ready.then(start).catch((error) => {
      sse.push("error", { message: error?.message ?? String(error) });
      settle(reject, error);
    });
  });
}
//#endregion

//#region 对局会话注册表
/** 模块级共享:coach-live 监控会话句柄与 logstream tailer(供 coach_replay 工具用) */
let monitor = null;
let liveMonitor = null;
let liveTailer = null;
/** 暂停/恢复控制器{toggle/stop/resume/isPaused},供 coach_stop_replay/coach_resume_replay 工具用 */
let livePauseController = null;
/** 实时对局状态快照(logstream 更新,动态插件循环读):仪表盘/二维图的数据源 */
let liveState = {
  updatedAt: 0,
  paused: false,
  game: null,           // 当前正在对话的游戏 id(wzry / lol …),供仪表盘按游戏切换视图
  score: null,
  economy: null,
  gameTime: null,
  roster: null,
  lastBroadcast: null,
  lastReply: null,
  // 最近一次回合失败的原因(阶段/key/消息)。"教练不说话"必须能从这里读到具体原因,
  // 而不是只能靠翻 DSH 的 stdout —— 真机事故里那份输出根本没被重定向。
  lastError: null,
  agentStatus: "idle",
  agentStep: 0,
  lastOcrFrame: null,   // { canvas:{w,h}, words:[{text, top,left,width,height}] }
  lastMinimap: null     // YOLO/小地图 ASCII or detections
};
// ── PC 教练状态(手机副屏)───────────────────────────────────────────────
// 纯新增旁路:与 /ai/generate、logstream、教练回合完全无关,发布失败不影响教练。
// 链路:PC 发布器 → POST /pc/state → 这里 → 注入 App 的 /sse/{userId} 流。
let pcState = { at: null, phase: null, lines: [], receivedAt: 0 };
const pcSseClients = new Set();

/**
 * 把 PC 状态按行推给已连接的 App。
 * ⚠ **必须一行一个事件**:App 的解析器对 `data:` 是**覆盖式赋值**
 *   (`ScreenshotSseStream.parse`: data = line.substring(5).trim()),
 *   一个事件里写多行 data 只会保留最后一行 —— 那会让手机上只看到半句话。
 */
function pushPcLines(lines) {
  for (const client of pcSseClients) {
    for (const raw of lines) {
      const line = String(raw).replace(/\r?\n/g, " ");
      try { client.write(`event: progress\ndata: ${line}\n\n`); } catch { /* 客户端已断开 */ }
    }
  }
}
/** 广播式 SSE 事件源(Phase 2 dashboard):/coach/stream 把 monitor 回合的
 *  phase/tool/speaking 帧实时广播给所有网页客户端,肉眼可见教练思考/工具调用/播报。 */
const sseHub = {
  clients: new Set(), // Set<SseStream>
  write(type, data) {
    const seq = ++sseBroadcastSeq;
    const frame = `data: ${JSON.stringify({ type, seq, ts: Date.now(), data })}\n\n`;
    for (const s of [...this.clients]) {
      try {
        s.write(frame);
      } catch {
        this.clients.delete(s); // 写失败(客户端断开)自动移除
      }
    }
  },
  add(sse) {
    this.clients.add(sse);
    return () => this.clients.delete(sse);
  }
};
/** 广播 seq:全局递增,供前端排序/去抖 */
let sseBroadcastSeq = 0;
let liveStateFlushTimer = null;
/** 更新并节流刷新 liveState 落盘(工作区 JSON,供前端轮询) */
function flushLiveState(cfg) {
  liveState.updatedAt = Date.now();
  if (liveStateFlushTimer) return;
  liveStateFlushTimer = setTimeout(() => {
    liveStateFlushTimer = null;
    try {
      const f = joinPath(cfg.sessionCwd, "coach_live_state.json");
      writeFileSync(f, JSON.stringify(liveState), "utf8");
    } catch { /* 目录/权限失败忽略 */ }
  }, 150);
}
function updateLiveState(patch, cfg) {
  Object.assign(liveState, patch);
  flushLiveState(cfg);
}

const coachRegistry = {
  matches: new Map(), // matchId -> { agent, ready, pending, createdAt }
  lastRequestAt: 0,
  epoch: 0,
  idleSessionMs: IDLE_SESSION_MS,

  resolveMatchId(body, headers) {
    if (body && typeof body.match_id === "string" && body.match_id) return `m-${body.match_id}`;
    if (headers && typeof headers["x-match-id"] === "string" && headers["x-match-id"]) {
      return `m-${headers["x-match-id"]}`;
    }
    const now = Date.now();
    if (now - this.lastRequestAt > this.idleSessionMs) this.epoch += 1;
    this.lastRequestAt = now;
    return `m-auto-${this.epoch}`;
  },

  ensure(ctx, cfg, matchId, adapter) {
    let entry = this.matches.get(matchId);
    if (entry) return entry;
    entry = {
      agent: null,
      ready: null,
      pending: new Map(),
      onReply: new Set(), // SSE 流式(Phase 2):coach_reply 回传时通知的订阅者(推 speaking/done 帧)
      createdAt: Date.now(),
      runningSince: 0,    // 本轮 agent 进入 running 的时刻(修复 #4:区分"本轮之前就挂起的请求")
      lastText: "",       // 本回合最后一条 assistant 文本(诊断/兜底)
      failPending(error) {
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(error);
        }
        this.pending.clear();
      },
      resolvePending(text) {
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.resolve({ response: text });
        }
        this.pending.clear();
      }
    };
    this.matches.set(matchId, entry);
    // 与本 agent 的 coach_reply 工具共享的回合状态(修复 #2/#3)
    const replyState = { replied: false };
    entry.ready = ctx.agentLoop.createAgent(ctx, {
      sessionId: `coach-${matchId}`,
      meta: { cwd: cfg.sessionCwd, agentPreset: cfg.coachPreset },
      agentOptions: { provider: cfg.provider, model: cfg.model },
      setup: async (agentCtx) => {
        const presets = agentCtx.get("agentPresets");
        if (presets) await presets.mount(agentCtx, cfg.coachPreset);
        // 修复 #2:coach_reply 提交后拒绝同回合的收尾 step(省一次 LLM 往返)
        installReplyStepGuard(agentCtx, replyState);
        // 修复 #4 观测:记录本回合最后一条 assistant 文本(便于诊断"未调 coach_reply"的回合)
        installAssistantTextTap(agentCtx, entry);
        agentCtx.tools.register(makeCoachReplyTool(entry, adapter, replyState));
        // 修复 #4 兜底:agent 回到 idle 说明本轮结束;若仍有挂起请求(本轮开始前就排队的),
        // 说明模型没调 coach_reply → 立即按静音放行,不再干等 deepTimeoutMs(旧行为会卡 20s)。
        agentCtx.on("agent/status", ({ agent: a, status }) => {
          if (status === "running") { entry.runningSince = Date.now(); return; }
          if (status !== "idle") return;
          if (entry.agent && a !== entry.agent) return; // 只处理本 agent
          if (entry.pending.size === 0) return;
          const before = entry.runningSince;
          let resolved = 0;
          for (const [turnId, p] of [...entry.pending]) {
            if (p.sentAt !== undefined && before && p.sentAt > before) continue; // 本轮开始后才排队的,留给下一轮
            clearTimeout(p.timer);
            entry.pending.delete(turnId);
            p.resolve({ response: "" });
            resolved += 1;
          }
          if (resolved > 0) {
            console.warn(`[coach-server] turn ended without coach_reply; released ${resolved} pending request(s) as silent (lastText=${JSON.stringify((entry.lastText || "").slice(0, 40))})`);
          }
        });
      }
    }).then((published) => {
      const agent = published?.agent ?? published;
      entry.agent = agent;
      // 侧边栏可见性:深路径对局会话也显式 attach 到 workspace,可在侧边栏打开看对局记忆
      attachSessionToWorkspace(ctx, cfg, `coach-${matchId}`);
      return agent;
    }).catch((error) => {
      console.warn(`[coach-server] createAgent failed for ${matchId}: ${error?.message ?? error}`);
      throw error;
    });
    return entry;
  }
};
//#endregion

//#region 透传(感知/TTS 凭证)
async function proxyToUpstream(cfg, req, res, path) {
  try {
    const rawBody = await readBody(req, 20 * 1024 * 1024);
    const headers = {};
    for (const h of ["authorization", "content-type", "accept", "user-agent", "x-request-id", "x-forwarded-for"]) {
      const v = req.headers[h];
      if (v !== undefined) headers[h] = Array.isArray(v) ? v.join(",") : String(v);
    }
    const upstreamResp = await fetch(`${cfg.upstream}${path}`, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : rawBody,
      signal: AbortSignal.timeout(30000)
    });
    const upstreamBody = Buffer.from(await upstreamResp.arrayBuffer());
    res.writeHead(upstreamResp.status, {
      "content-type": upstreamResp.headers.get("content-type") ?? "application/json",
      "access-control-allow-origin": "*"
    });
    res.end(upstreamBody);
  } catch (error) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "upstream proxy failed", detail: error?.message ?? String(error) }));
  }
}
//#endregion

//#region HTTP
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(payload));
}

/** 转义 XML 文本节点内容(去标签 + 实体) */
function stripXml(text) {
  return String(text ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim();
}

/** 从 Bing RSS XML 中提取搜索结果条目 */
function parseBingRss(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] ?? "";
    const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] ?? "";
    const desc = (block.match(/<description>([\s\S]*?)<\/description>/) || [])[1] ?? "";
    const pub = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] ?? "";
    if (!link) continue;
    const cleanTitle = stripXml(title);
    const cleanDesc = stripXml(desc);
    if (!cleanTitle && !cleanDesc) continue;
    items.push({
      url: link.trim(),
      ...cleanTitle ? { title: cleanTitle } : {},
      ...cleanDesc ? { snippet: cleanDesc.slice(0, 400) } : {},
      ...stripXml(pub) ? { publishedAt: stripXml(pub) } : {}
    });
  }
  return items;
}

/**
 * 创建基于 opencode 网关的检索式 web search provider(免 DeepSeek 官方 key)。
 * 流程:用 opencode 的 DeepSeek V4 Flash(ctx.llm, provider=opencode-go, model=deepseek-v4-flash)
 * 把用户 query 改写/精简为 1-2 个搜索词,再请求 Bing RSS 返回真实 url/title/snippet。
 * 模型失败时降级为原 query 直接检索,保证搜索永远可用。
 * id 注册为 OPENCODE_SEARCH_PROVIDER_ID。
 */
function createSearchProvider(ctx, cfg) {
  return {
    id: OPENCODE_SEARCH_PROVIDER_ID,
    available() {
      return true;
    },
    async search(request, signal) {
      const query = String(request?.query ?? "").trim();
      if (!query) throw new Error(`opencode-go-search: empty query`);
      const max = Number.isInteger(request?.maxResults) && request.maxResults > 0
        ? request.maxResults
        : SEARCH_MAX_RESULTS_DEFAULT;
      // 1) opencode DeepSeek V4 Flash 改写查询(成功时优先用改写词;失败/超时降级为原 query)
      let queries = [query];
      try {
        const rewritten = await rewriteSearchQuery(ctx, cfg, query, signal);
        if (Array.isArray(rewritten) && rewritten.length > 0) {
          // 改写词优先(原长句常含"请问/想了解"等噪音词,Bing 检索效果差)
          queries = [...rewritten, query].filter((q, i, a) => a.indexOf(q) === i).slice(0, 3);
        }
      } catch { /* keep raw query */ }
      // 2) Bing RSS 抓取
      const seen = new Set();
      const sources = [];
      for (const q of queries) {
        if (sources.length >= max) break;
        const url = BING_RSS_URL + encodeURIComponent(q);
        const r = await fetch(url, {
          headers: { "user-agent": SEARCH_UA, accept: "application/rss+xml, application/xml, text/xml" },
          ...signal !== void 0 ? { signal } : {}
        });
        if (!r.ok) continue;
        const xml = await r.text();
        let items = [];
        try { items = parseBingRss(xml); } catch { items = []; }
        for (const it of items) {
          if (sources.length >= max) break;
          if (seen.has(it.url)) continue;
          seen.add(it.url);
          sources.push(it);
        }
      }
      if (sources.length === 0) throw new Error(`opencode-go-search: no results for "${query}"`);
      return { sources, truncated: false };
    }
  };
}

/** 用 opencode 的 DeepSeek V4 Flash 把 query 改写成 1-2 个精简搜索词(JSON 数组)。 */
async function rewriteSearchQuery(ctx, cfg, query, signal) {
  const messages = [
    {
      role: "system",
      content: [{ type: "text", text: "把用户的长查询改写成最适合搜索引擎的 1-2 个精简中文关键词,只用 JSON 字符串数组回答,不要任何解释或思考过程。示例: [\"王者荣耀 攻略\",\"狄仁杰 出装 2026\"]" }]
    },
    {
      role: "user",
      content: [{ type: "text", text: `查询: ${query}` }]
    }
  ];
  const text = await withTimeout(
    () => directLlmText(ctx, cfg, messages, signal, 8000, { maxTokens: 300, reasoningEffort: "minimal" }),
    8000,
    () => ""
  );
  if (!text) { console.log("[coach-server] search rewrite empty"); return []; }
  console.log(`[coach-server] search rewrite raw: ${JSON.stringify(text)}`);
  const m = text.match(/\[[\s\S]*?\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return [];
    return arr.map((s) => String(s).trim()).filter(Boolean).slice(0, 2);
  } catch {
    return [];
  }
}

function withTimeout(fn, ms, fallback) {
  return Promise.race([
    fn(),
    sleep(ms).then(fallback)
  ]);
}

function apply(ctx, config) {
  const cfg = config;
  coachRegistry.idleSessionMs = cfg.idleSessionMs;

  // ── 画面理解兜底(多模态模型看截图)───────────────────────────────
  // 依赖 ctx 上的 llm(模型调用)与 attachments(图片校验/归一化)。
  // 两者都由 dsh-base 挂载;缺任何一个,analyze() 会返回 ok:false 而不是抛异常,
  // 调用方(companion)据此回退本地结论 —— 兜底功能不可用不该拖垮主链路。
  const vision = createVision(ctx, cfg);
  {
    const hasLlm = !!ctx.get("llm"), hasAtt = !!ctx.get("attachments");
    console.log(`[coach-server] 画面兜底: ${cfg.visionEnabled === false ? "已关闭" : "启用"}` +
      ` (llm=${hasLlm ? "有" : "缺"} attachments=${hasAtt ? "有" : "缺"} model=${cfg.provider}/${cfg.model})`);
    if (cfg.visionEnabled !== false && (!hasLlm || !hasAtt)) {
      console.warn("[coach-server] ⚠ 画面兜底缺少依赖服务,调用时会失败并回退本地结论");
    }
  }

  // ── 多游戏适配器注册表(Phase 0)───────────────────────────────────
  // 内核零游戏知识:所有游戏相关数据/文案都来自注册表按 game 解析的 adapter。
  // 默认注册内置王者 adapter;未来每款新游戏只需 register 自己的 adapter 即可。
  const gameRegistry = createGameRegistry();
  gameRegistry.register(WZRY_ADAPTER);
  gameRegistry.register(LOL_ADAPTER);
  try {
    ctx.provide("gameRegistry", gameRegistry);
  } catch (error) {
    console.warn(`[coach-server] gameRegistry provide failed: ${error?.message ?? error}`);
  }
  // 解析当前请求的 game → adapter(默认 wzry;未命中回退默认游戏)
  const resolveGame = (game) => gameRegistry.resolve(game || "wzry", "wzry") || WZRY_ADAPTER;
  // 日志源 → adapter:多游戏共用一个 watchDir 时,靠"行内 game 字段 → 文件名前缀 <gameId>- → 默认游戏"三级解析。
  // 王者日志(adb_*.jsonl,无 game 字段)不受影响,仍落到默认游戏。
  const adapterOfLog = (raw, file) => {
    const g = raw && typeof raw.game === "string" ? raw.game.toLowerCase() : "";
    if (g) { const a = gameRegistry.get(g); if (a) return a; }
    const m = /^([a-z][a-z0-9]{1,15})-/i.exec(String(file ?? ""));
    if (m) { const a = gameRegistry.get(m[1].toLowerCase()); if (a) return a; }
    return resolveGame(cfg.defaultGame ?? "wzry");
  };

  // 注册自建 web_search provider(opencode 网关检索:DeepSeek V4 Flash 改写 + Bing RSS)。
  // 依赖方:dsh-web 的 searchProvider 配置须指向 OPENCODE_SEARCH_PROVIDER_ID
  // (在 cordis.patch.yml 改),web_search 工具即用此 provider,不再依赖失效的 DeepSeek key。
  const webSvc = ctx.get("web");
  if (webSvc && typeof webSvc.registerSearchProvider === "function") {
    try {
      webSvc.registerSearchProvider(createSearchProvider(ctx, cfg));
      console.log(`[coach-server] registered web search provider "${OPENCODE_SEARCH_PROVIDER_ID}"`);
    } catch (error) {
      console.warn(`[coach-server] web search provider register failed: ${error?.message ?? error}`);
    }
  }

  ctx.systemPrompt.section({
    name: "tool:coach-server",
    order: 120,
    text: "DSH 同时运行着金宝教练后端(coach-server,端口 " + cfg.port + "):App 通过 /ai/generate 送来对局请求(可带 game 参数,已注册: " + gameRegistry.list().map((g) => g.id).join(", ") + "),深路径由每局一个的 coach agent 会话处理(带对局记忆,可用 site_query / web_search)。需要排查时可用 coach_sessions 查看活动对局。"
  });

  // agent 回合出错时,让挂起的教练请求快速失败(而不是干等超时)
  ctx.on("agent/error", ({ agent, error }) => {
    if (!agent) return;
    for (const [, entry] of coachRegistry.matches) {
      if (entry.agent === agent) {
        entry.failPending(error instanceof Error ? error : new Error(String(error)));
        break;
      }
    }
  });

  ctx.tools.register(defineTool({
    name: "coach_sessions",
    description: "List active coach match sessions and their pending request counts.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          sessions: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: true,
              properties: {
                matchId: { type: "string", required: true },
                pending: { type: "integer", required: true },
                createdAt: { type: "integer", required: true }
              }
            }
          }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: value.sessions.length === 0
          ? "No active coach sessions."
          : value.sessions.map((s) => `- ${s.matchId}: ${s.pending} pending (created ${new Date(s.createdAt).toISOString()})`).join("\n")
      }]
    },
    timeoutMs: 5000,
    isConcurrencySafe: () => true,
    async execute() {
      return {
        sessions: [...coachRegistry.matches.entries()].map(([matchId, entry]) => ({
          matchId,
          pending: entry.pending.size,
          createdAt: entry.createdAt
        }))
      };
    }
  }));

  ctx.tools.register(defineTool({
    name: "coach_replay",
    description: "手动触发 watchDir 下某个 adb jsonl 日志的 1x 重新回放(模拟实时):重置该文件偏移并重新按日志时间戳排程,事件实时追加到 coach-live 会话(侧边栏可见)。用于\"模拟测试\"或回放既有对局日志。",
    parameters: {
      file: { type: "string", required: true, description: "watchDir 下的 jsonl 文件名(如 adb_key_20260824_233416_part01.jsonl),或绝对路径" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { ok: { type: "boolean", required: true }, message: { type: "string", required: true } }
      },
      render: (_a, v) => [{ type: "text", text: v.message }]
    },
    timeoutMs: 5000,
    isConcurrencySafe: () => true,
    async execute(args) {
      if (!liveTailer) {
        return { ok: false, message: "logstream tailer 未启动(启动时 watchEnabled=false 或仍在 5s 延迟内),稍后重试。" };
      }
      let file = args.file;
      if (!file.endsWith(".jsonl")) file = file + ".jsonl";
      // 支持绝对路径:提取 basename(必须在 watchDir 内)
      const base = file.includes("/") || file.includes("\\") ? file.split(/[\\/]/).pop() : file;
      // 确认文件存在
      const fullPath = joinPath(cfg.watchDir, base);
      if (!existsSync(fullPath)) {
        return { ok: false, message: `文件不存在: ${fullPath}` };
      }
      liveTailer.replayFile(base);
      // 若之前被 coach_stop_replay 暂停,触发回放时自动恢复对话
      if (livePauseController?.isPaused?.()) livePauseController.resume();
      const ready = liveMonitor?.isReady?.() ?? false;
      return {
        ok: true,
        message: `已重新触发 ${base} 的 1x 回放。${ready ? "coach-live 会话已就绪,输出会实时追加,请打开侧边栏 \"对局实时播报 (coach-live)\" 查看。" : "coach-live 会话仍在创建中,输出会进入启动缓冲,就绪后自动追加。"}`
      };
    }
  }));

  ctx.tools.register(defineTool({
    name: "coach_stop_replay",
    description: "暂停/停止日志回放与自动对话:停掉 1x 回放排程、清空防抖队列,之后新的日志事件不再触发教练对话(已进行中的回合会自然完成)。恢复用 coach_resume_replay。",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { ok: { type: "boolean", required: true }, message: { type: "string", required: true } }
      },
      render: (_a, v) => [{ type: "text", text: v.message }]
    },
    timeoutMs: 5000,
    isConcurrencySafe: () => true,
    async execute() {
      if (!livePauseController) {
        return { ok: false, message: "logstream 尚未启动(或 watchEnabled=false),无可暂停的回放。" };
      }
      livePauseController.pause();
      console.log("[coach-server] logstream replay/dialog paused");
      return { ok: true, message: "已暂停日志回放与自动对话。新的日志事件不会再触发教练对话;当前正在进行的回合会自然结束。需要恢复时调用 coach_resume_replay。" };
    }
  }));

  ctx.tools.register(defineTool({
    name: "coach_resume_replay",
    description: "恢复被 coach_stop_replay 暂停的日志流监控与自动对话(从暂停点继续消费)。",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { ok: { type: "boolean", required: true }, message: { type: "string", required: true } }
      },
      render: (_a, v) => [{ type: "text", text: v.message }]
    },
    timeoutMs: 5000,
    isConcurrencySafe: () => true,
    async execute() {
      if (!livePauseController) {
        return { ok: false, message: "logstream 尚未启动,无可恢复。" };
      }
      if (!livePauseController.isPaused()) {
        return { ok: true, message: "当前并未处于暂停状态。" };
      }
      livePauseController.resume();
      console.log("[coach-server] logstream replay/dialog resumed");
      return { ok: true, message: "已恢复日志流监控与自动对话,从暂停点继续消费。" };
    }
  }));

  const server = createServer(async (req, res) => {
    // CORS:浏览器页面(3080)跨域调用 coach API(3081)。POST JSON 触发 preflight,
    // 必须响应 OPTIONS 并声明允许的方法/请求头,否则浏览器拦截请求。
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type, authorization, x-request-id");
    res.setHeader("access-control-max-age", "600");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    try {
      if (req.method === "GET" && path === "/health") {
        sendJson(res, 200, { ok: true, coach: true, version: "0.1.0" });
        return;
      }
      if (req.method === "GET" && path === "/coach/state") {
        // 前端仪表盘/二维图轮询的实时状态快照(coach_live_state.json 内存版)+ 已注册游戏列表
        // ⚠ 一并暴露 **monitor 会话健康度**:真机踩过"monitor 建不起来 → 所有回合
        //   静默消失"的坑(134 个回合没有任何输出),而当时**任何可见指标都正常**
        //   (liveState 一直在更新)。把这个状态放进 /coach/state,
        //   仪表盘/排查脚本就能一眼看出"链路是断的",而不是以为教练在静默。
        sendJson(res, 200, {
          ...liveState,
          games: gameRegistry.list(),
          monitor: typeof liveMonitor?.health === "function" ? liveMonitor.health() : null,
        });
        return;
      }
      if (req.method === "POST" && path === "/coach/control") {
        // 前端按钮控制:action = pause | resume | replay | stop
        const raw = await readBody(req, 64 * 1024);
        let body;
        try {
          body = JSON.parse(raw.toString("utf8"));
        } catch {
          sendJson(res, 400, { error: "invalid json" });
          return;
        }
        const action = body.action;
        if (!livePauseController) {
          sendJson(res, 200, { ok: false, message: "logstream 尚未启动" });
          return;
        }
        if (action === "pause") {
          livePauseController.pause();
          console.log("[coach-server] /coach/control pause");
          sendJson(res, 200, { ok: true, action: "pause", paused: true });
        } else if (action === "resume") {
          livePauseController.resume();
          console.log("[coach-server] /coach/control resume");
          sendJson(res, 200, { ok: true, action: "resume", paused: false });
        } else if (action === "replay") {
          // 找 watchDir 下最新/第一个 jsonl 重放(可指定 file)
          const file = body.file;
          if (file) livePauseController.replay(file);
          else {
            const files = readdirSync(cfg.watchDir).filter((f) => f.endsWith(".jsonl") && !f.startsWith("coach_")).sort();
            if (files.length === 0) { sendJson(res, 200, { ok: false, message: "watchDir 无 jsonl 日志" }); return; }
            livePauseController.replay(files[0]);
          }
          console.log("[coach-server] /coach/control replay");
          sendJson(res, 200, { ok: true, action: "replay", paused: false });
        } else if (action === "stop") {
          // 停止:暂停分发 + 清空对话队列与防抖(等同暂停,但语义上彻底停)
          livePauseController.pause();
          console.log("[coach-server] /coach/control stop");
          sendJson(res, 200, { ok: true, action: "stop", paused: true });
        } else if (action === "interrupt") {
          // 立即中断当前 agent 回合(Phase 2 健壮性):agent.cancel 终止正在跑的 step,
          // 不清 inbox(keepInbox),让已入队的消息保留;可指定 matchId 或中断全部活动回合。
          const matchId = typeof body.match_id === "string" && body.match_id ? `m-${body.match_id}` : null;
          let interrupted = 0;
          for (const [mid, entry] of coachRegistry.matches) {
            if (matchId && mid !== matchId) continue;
            if (entry.agent) {
              interruptedMatchIds.add(mid); // 让进行中的 /ai/stream 推 cancel 帧
              try {
                entry.agent.cancel(new Error("interrupt requested"), { keepInbox: true });
                interrupted += 1;
              } catch { /* noop */ }
            }
          }
          console.log(`[coach-server] /coach/control interrupt match=${matchId ?? "all"} agents=${interrupted}`);
          sendJson(res, 200, { ok: true, action: "interrupt", interrupted });
        } else {
          sendJson(res, 400, { error: "unknown action: " + action });
        }
        return;
      }
      if (req.method === "POST" && path === "/ai/generate") {
        const raw = await readBody(req, 2 * 1024 * 1024);
        let body;
        try {
          body = JSON.parse(raw.toString("utf8"));
        } catch {
          sendJson(res, 400, { error: "invalid json" });
          return;
        }
        const signal = AbortSignal.timeout(Math.max(cfg.fastTimeoutMs, cfg.deepTimeoutMs) + 2000);
        const matchId = coachRegistry.resolveMatchId(body, req.headers);
        const adapter = resolveGame(body.game);
        const deep = isDeepRequest(body, adapter);
        console.log(`[coach-server] /ai/generate game=${adapter.id} route=${deep ? "deep" : "fast"} match=${matchId} promptChars=${(body.prompt ?? "").length} systemChars=${(body.system_prompt ?? "").length}`);
        const result = deep
          ? await deepReply(ctx, cfg, body, matchId, signal, adapter)
          : await fastReply(ctx, cfg, body, signal);
        sendJson(res, 200, result);
        return;
      }
      if (req.method === "POST" && path === "/ai/stream") {
        // SSE 流式端点(Phase 2):统一信封 {type,seq,ts,data}。
        // body: { game?, prompt, system_prompt?, model?, maxToolSteps?, lastSeq? }
        //   - lastSeq>0:断线续接 —— 先重放缓冲中 seq>lastSeq 的帧,再继续推进。
        //   - 深路径(agent 回合):phase(collecting/thinking/speaking) + tool + done/error/cancel
        //   - 快路径(直连):phase(collecting/thinking/speaking) + done/error
        const raw = await readBody(req, 2 * 1024 * 1024);
        let body;
        try {
          body = JSON.parse(raw.toString("utf8"));
        } catch {
          sendJson(res, 400, { error: "invalid json" });
          return;
        }
        const signal = AbortSignal.timeout(Math.max(cfg.fastTimeoutMs, cfg.deepTimeoutMs) + 3000);
        // SSE 头 + 创建 SseStream(seq/缓冲由它维护)
        for (const [k, v] of Object.entries(sseHeaders())) res.setHeader(k, v);
        res.writeHead(200);
        const sse = new SseStream((frame) => res.write(frame));
        // 断线续接:客户端断开连接 → 中断当前回合
        const onDisconnect = () => {
          const entry = coachRegistry.matches.get(matchId);
          const ag = entry?.agent;
          if (ag) { try { ag.cancel(new Error("sse client disconnected")); } catch { /* noop */ } }
          try { sse.push("cancel", { message: "client disconnected" }); } catch { /* noop */ }
          try { res.end(); } catch { /* noop */ }
        };
        req.on("close", onDisconnect);
        // 若带 lastSeq 重连:先重放缓冲里已有的帧
        const lastSeq = Number.isFinite(Number(body.lastSeq)) ? Number(body.lastSeq) : 0;
        if (lastSeq > 0) sse.resume(lastSeq);
        const matchId = coachRegistry.resolveMatchId(body, req.headers);
        const adapter = resolveGame(body.game);
        const deep = isDeepRequest(body, adapter);
        console.log(`[coach-server] /ai/stream game=${adapter.id} route=${deep ? "deep" : "fast"} match=${matchId} lastSeq=${lastSeq} promptChars=${(body.prompt ?? "").length}`);
        let result;
        try {
          if (deep) {
            result = await streamDeepReply(ctx, cfg, body, matchId, signal, adapter, sse, {
              maxToolSteps: body.maxToolSteps
            });
          } else {
            // 快路径直连:phase 帧 + done
            sse.push("phase", { name: "collecting" });
            sse.push("phase", { name: "thinking" });
            const text = await fastReply(ctx, cfg, body, signal);
            const response = text?.response ?? "";
            sse.push("phase", { name: "speaking", text: response });
            sse.push("done", { response });
            result = { response };
          }
        } catch (error) {
          // streamDeepReply 的 error 分支已推 error 帧;这里只记日志,不重写响应
          // (SSE 头已发,sendJson(500) 会覆盖已写内容)
          console.warn(`[coach-server] /ai/stream error match=${matchId}: ${error?.message ?? error}`);
          result = { response: "" };
        }
        console.log(`[coach-server] /ai/stream done match=${matchId} response=${(result?.response ?? "").slice(0, 40) || "(empty)"}`);
        try { res.end(); } catch { /* noop */ }
        return;
      }
      // ── PC 教练状态(手机副屏,纯新增)────────────────────────────────────
      // 发布器上报(POST)与查询(GET,手机浏览器可直接打开验证)。
      if (path === "/pc/state") {
        if (req.method === "POST") {
          let body;
          try { body = JSON.parse((await readBody(req, 256 * 1024)).toString("utf8")); }
          catch { sendJson(res, 400, { error: "invalid json" }); return; }
          const lines = Array.isArray(body?.lines) ? body.lines.slice(0, 12).map((x) => String(x)) : [];
          pcState = { at: body?.at ?? Date.now(), phase: body?.phase ?? null, lines, receivedAt: Date.now() };
          pushPcLines(lines);
          sendJson(res, 200, { ok: true, lines: lines.length, sseClients: pcSseClients.size });
          return;
        }
        sendJson(res, 200, pcState);
        return;
      }
      // App 的推送通道:原来直接透传到云,现在本地实现 ——
      // ① 中继云端 SSE(原有截图分析流程**照旧可用**);② 把 PC 状态插进同一个流。
      // App 侧零改动:它解析的 progress/result 事件形状完全不变。
      if (req.method === "GET" && path.startsWith("/sse/")) {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        // 连上先补一份当前 PC 状态(App 立刻能看到,不用等下次变化)
        for (const raw of pcState.lines ?? []) res.write(`event: progress\ndata: ${String(raw).replace(/\r?\n/g, " ")}\n\n`);
        pcSseClients.add(res);
        const cleanup = () => { pcSseClients.delete(res); };
        req.on("close", cleanup);
        res.on("close", cleanup);
        try {
          // ⚠ 两个必须:**保留 query** + **原样转发请求头**。
          //   云端 /sse/{userId} 要鉴权(实测直连返回 {"code":"AUTH_REQUIRED"}),
          //   App 靠微信登录后的凭证访问;而本文件的 path = url.pathname **不含 query**,
          //   直接拿它拼上游会把凭证丢掉 → App 会收到 AUTH_REQUIRED。
          const upHeaders = { accept: "text/event-stream" };
          for (const [k, v] of Object.entries(req.headers)) {
            const lk = String(k).toLowerCase();
            if (lk === "host" || lk === "connection" || lk === "accept-encoding" || lk === "content-length") continue;
            if (typeof v === "string") upHeaders[k] = v;
          }
          const upUrl = new URL(`/sse/${encodeURIComponent(path.slice("/sse/".length))}`, cfg.upstream);
          upUrl.search = url.search;   // ← 保留 query(凭证可能在这里)
          const up = await fetch(upUrl, { headers: upHeaders });
          if (!up.ok || !up.body) {
            // ⚠ **必须把上游的失败透传回 App**,不能吞掉:
            //   实测未带凭证时上游返回 401 {"code":"AUTH_REQUIRED"}。
            //   如果这里只是 console.warn 然后 return,App 侧表现为"流开着但永远没有结果" ——
            //   也就是截图分析**静默失效**,连错因都看不到。透传后至少能看见 AUTH_REQUIRED。
            const detail = await up.text().catch(() => "");
            console.warn(`[coach-server] /sse 中继上游返回 ${up.status},已透传给 App: ${detail.slice(0, 120)}`);
            try {
              res.write(`event: error\ndata: ${String(detail || `upstream ${up.status}`).replace(/\r?\n/g, " ")}\n\n`);
              res.end();
            } catch { /* App 已断开 */ }
            return;
          }
          for await (const chunk of up.body) { try { res.write(chunk); } catch { break; } }
          try { res.end(); } catch { /* 已断开 */ }
        } catch (e) {
          console.warn(`[coach-server] /sse 中继异常(PC 状态不受影响): ${e?.message ?? e}`);
        }
        return;
      }
      if (req.method === "GET" && path === "/coach/stream") {
        // 广播式 SSE 事件源(Phase 2 dashboard):把 monitor 回合的 phase/tool/speaking
        // 帧实时广播给网页客户端;不额外触发回合(消费现有 logstream 驱动的会话)。
        for (const [k, v] of Object.entries(sseHeaders())) res.setHeader(k, v);
        res.writeHead(200);
        // 连上即推当前 agent 状态,前端据此知道"待命/思考中"
        res.write(`data: ${JSON.stringify({ type: "phase", seq: ++sseBroadcastSeq, ts: Date.now(), data: { name: liveState.agentStatus === "running" ? "thinking" : "idle", agentStatus: liveState.agentStatus } })}\n\n`);
        const off = sseHub.add({ write: (frame) => res.write(frame) });
        const onClose = () => off();
        req.on("close", onClose);
        res.on("error", onClose);
        // 保持连接(SSE 长连接直到页面断开)
        return;
      }
      // ── 画面理解兜底(本地实现,不再透传到上游)────────────────────────
      // 原来 /vision/analyze 只是 proxyToUpstream 透传,而上游是**游戏业务网关**,
      // 根本没有这个接口 —— 也就是说这个路径从来没有真正工作过,
      // 而 cordis.patch.yml 的注释却写着"服务端也能看画面"。这里把它做成真的。
      //
      // body: { image: "<本地路径>" } 或 { imageBase64, mediaType }
      // 响应: { ok, data: {game, screen, mode, me, allies, enemies, state, confidence, uncertain}, ms }
      if (req.method === "POST" && path === "/vision/analyze") {
        const raw = await readBody(req, 20 * 1024 * 1024);
        let body;
        try { body = JSON.parse(raw.toString("utf8")); } catch { sendJson(res, 400, { ok: false, error: "invalid json" }); return; }
        if (!body?.image) { sendJson(res, 400, { ok: false, error: "missing 'image' (local path)" }); return; }
        const out = await vision.analyze(String(body.image), { extra: body.hint ? String(body.hint) : null });
        console.log(`[coach-server] /vision/analyze ${out.ok ? "ok" : "failed"} ms=${out.ms}` +
          (out.ok ? ` game=${out.data.game ?? "?"} screen=${out.data.screen} mode=${out.data.mode ?? "?"} conf=${out.data.confidence}` : ` err=${out.error}`));
        sendJson(res, out.ok ? 200 : 502, out);
        return;
      }
      if (req.method === "POST" && ["/tts/token", "/realtime/token", "/vision/ocr"].includes(path)) {
        await proxyToUpstream(cfg, req, res, path);
        return;
      }
      sendJson(res, 404, { error: "not found" });
    } catch (error) {
      sendJson(res, 500, { error: "internal", detail: error?.message ?? String(error) });
    }
  });

  server.listen(cfg.port, "127.0.0.1", () => {
    console.log(`[coach-server] listening on http://127.0.0.1:${cfg.port} (upstream=${cfg.upstream}, model=${cfg.provider}/${cfg.model})`);
    diagLog(`── coach-server 启动 ── port=${cfg.port} model=${cfg.provider}/${cfg.model} watchDir=${cfg.watchDir}`, cfg);
  });
  ctx.effect(() => () => server.close());

  // ── 日志流监控:实时读 App 的 adb jsonl 日志 ─────────────────────────
  // 延迟启动,等 LLM 适配器/设置加载完成(启动时序问题会让首次调用失败)
  if (cfg.watchEnabled) {
    // 对局/监控会话都是临时的:启动时清掉上次残留的所有 coach-* 会话(避免 id collision)。
    // 注意:监控会话 id 每次启动唯一(coach-live-{ts}),因此所有 coach-* 都是上次的残留,
    // 可以安全清理;若保留旧持久化日志,DSH 会因"磁盘日志与 live session 不匹配"拒绝重建。
    if (cfg.sessionCleanup !== false) {
      try {
        const home = process.env.DSH_HOME ?? joinPath(homedir(), ".dsh");
        // 枚举 sessions 根下全部 bucket(含旧 cwd 桶),清理所有 coach-* 残留会话,
        // 不依赖 bucket 名猜测(cwd 分隔符会被 DSH 合并成单个 '-' 再包裹 '--')。
        const sessionsRoot = joinPath(home, "sessions");
        if (existsSync(sessionsRoot)) {
          for (const bucketName of readdirSync(sessionsRoot, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)) {
            const bucketPath = joinPath(sessionsRoot, bucketName);
            for (const sessionName of readdirSync(bucketPath)) {
              if (sessionName.startsWith("coach-")) {
                rmSync(joinPath(bucketPath, sessionName), { recursive: true, force: true });
                console.log(`[coach-server] cleaned stale coach session: ${bucketName}/${sessionName}`);
              }
            }
          }
        }
      } catch (error) {
        console.warn(`[coach-server] session cleanup error: ${error?.message ?? error}`);
      }
    }
    const startTailer = () => {
      let briefCount = 0;
      let broadcastCount = 0;
      liveMonitor = createMonitor(ctx, cfg, resolveGame);
      const pushMonitor = liveMonitor;

      // ── 事件分层 + 聚合防抖调度器(Phase 1)───────────────────────────
      // 事件分两层:
      //   · observation(ocr/brief/minimap):实时事实 → 聚合进 collecting 近窗 buffer,
      //     不每事件触发回合;窗口到(COLLECT_MS 空闲或达上限)合并成单回合输入。
      //   · interaction(用户显式 LLM 请求):高优先级 → 立即 flush(把近窗 observation
      //     一起带上作为上下文),不等待窗口。
      // 去重:同 kind 同内容(前 60 字 hash)在 dedupeMs 窗口内只收一次。
      // 效果:高频段从"每事件一回合"(旧 269 回合)降为"每窗口一回合",上下文大幅收敛。
      const DEDUPE_MS = 30000;
      const COLLECT_MS = 3000;       // 观察窗口:空闲 3s 合并一次(较旧 8s/kind 更聚合)
      const COLLECT_MAX = 12;        // 单回合最多合并观察数(防单次过大)
      const recentHashes = new Map(); // "kind:hash" -> timestamp
      const collectBuffer = [];      // [{ event, sourceFile, adapter }] 聚合观察缓冲
      let collectTimer = null;
      // ── 游戏 adapter(解析层已 adapter 化,且多游戏共存)─────────────────
      // 本调度器不再含任何游戏知识:日志行解析、噪音过滤、上下文事件判定、
      // 事实指纹、信号分级、请求体拼装全部由**该事件所属游戏**的 adapter 提供
      // (见 adapters/wzry.js / adapters/lol.js 的 log / filter / prompt 三组钩子)。
      // 事件归属由 adapterOfLog(行内 game → 文件名前缀 → 默认游戏)决定,并在
      // classify 成功后写入 event.game,因此这里只需按 event.game 取回 adapter。
      const defaultAdapter = resolveGame(cfg.defaultGame ?? "wzry");
      const DEFAULT_DIALOG_KINDS = new Set(["interaction", "brief", "ocr", "minimap"]);
      const dialogKindsOf = (a) => a.dialogKinds ?? DEFAULT_DIALOG_KINDS;
      const canvasOf = (a) => a.view?.ocrCanvas ?? { w: 3200, h: 1440 };
      const adapterOfEvent = (ev, file) =>
        (ev && ev.game && gameRegistry.get(ev.game)) || defaultAdapter;
      /** 每款游戏一份解析状态(已见英雄/事件 id、事实指纹等):adapter 自己定义形状 */
      const stateByGame = new Map();
      const stateOf = (a) => {
        let s = stateByGame.get(a.id);
        if (!s) { s = a.createState ? a.createState() : {}; stateByGame.set(a.id, s); }
        return s;
      };
      /** 重置某游戏(或全部)的解析状态 —— 重放/暂停视为新起点。 */
      const resetStates = (a) => {
        if (a) stateByGame.set(a.id, a.createState ? a.createState() : {});
        else for (const g of gameRegistry.list()) { const ad = gameRegistry.get(g.id); stateByGame.set(g.id, ad.createState ? ad.createState() : {}); }
      };
      const filterOf = (a) => (a.filter ?? {});
      const isRelevant = (ev, a) => (filterOf(a).isRelevant ? filterOf(a).isRelevant(ev, stateOf(a)) : true);
      const isContextOnly = (ev, a) => (filterOf(a).contextOnly ? filterOf(a).contextOnly(ev, stateOf(a)) : false);
      const isFactChanged = (ev, src, a) => (filterOf(a).isFactChanged ? filterOf(a).isFactChanged(ev, stateOf(a), src) : true);
      const isHighSignalBatch = (evs, a) => (filterOf(a).isHighSignal ? filterOf(a).isHighSignal(evs, stateOf(a)) : true);
      // 上下文事件(YOLO 检测 / 可见性刷新 / 端游局势轮询)的最新快照 —— 只富化同窗口的
      // 触发回合,自身不触发。用 last-wins 而非列表,避免高频帧把窗口撑爆。
      const contextOnlyLatest = new Map(); // key -> { event, sourceFile, adapter, at }
      // 低信号(纯 OCR 截图)批次限流:实测纯 OCR 批次约 3/4 会被模型判"无战况"静音,
      // 每个都问一次模型纯浪费。限流期内的事件**推迟并入下次触发**(不丢)。
      const LOW_SIGNAL_MIN_MS = 30000;     // 低信号批次最小间隔(30s)
      const CONTEXT_SNAPSHOT_TTL_MS = 60000; // 上下文快照保鲜期:超时不再并入提示词
      let lastLowSignalAt = 0;
      let deferredEvents = [];
      let deferredSourceFile = "-";
      let deferredAdapter = defaultAdapter;
      let suppressedLowSignal = 0;

      function hashText(s) {
        let h = 0;
        const t = String(s ?? "").slice(0, 60);
        for (let i = 0; i < t.length; i++) { h = ((h << 5) - h + t.charCodeAt(i)) | 0; }
        return h.toString(36);
      }

      /** 清空聚合缓冲(暂停/停止时丢弃积压观察,避免停止后仍触发回合) */
      function clearCollect() {
        if (collectTimer) { clearTimeout(collectTimer); collectTimer = null; }
        collectBuffer.length = 0;
        resetStates(); // 重放视为新起点(所有游戏)
        contextOnlyLatest.clear();
        deferredEvents = [];
        deferredAdapter = defaultAdapter;
        lastLowSignalAt = 0;
        suppressedLowSignal = 0;
      }

      /** 触发一个 agent 回合,输入为聚合后的事件数组。
       *  请求体由该事件所属游戏的 adapter 拼装(prompt.eventsToBody),内核不含游戏文案。 */
      function submitDialog(events, sourceFile, adapter) {
        const a = adapter ?? defaultAdapter;
        const body = a.prompt?.eventsToBody
          ? a.prompt.eventsToBody(events, { systemPrompt: a.eventToBodySystemPrompt })
          : null;
        if (!body) return;
        const primary = events[0]; // 取首个作 kind/key 归因
        const matchId = `file-${sourceFile.replace(/\.jsonl$/i, "")}`;
        console.log(`[coach-server] logstream dialog game=${a.id} aggregated=${events.length} kinds=${events.map((e) => e.kind).join("+")} match=${matchId}`);
        updateLiveState({ agentStatus: "running", game: a.id, agentStep: liveState.agentStep + 1 }, cfg);
        liveMonitor.submitInteraction({ ...primary, _aggregated: events }, sourceFile, body).then((text) => {
          const entry = {
            at: new Date().toISOString(),
            source: sourceFile,
            game: a.id,
            match: matchId,
            kind: primary.kind,
            key: primary.key,
            context: primary.context ?? null,
            count: events.length,
            broadcast: text
          };
          appendBroadcast(cfg.broadcastFile, entry);
          console.log(`[coach-server] logstream ★播报(${primary.kind}×${events.length}): ${text || "(silent)"}`);
          diagLog(`★播报(${primary.kind}×${events.length}): ${text || "(静音)"}`, cfg);
          updateLiveState({ agentStatus: text ? "replied" : "idle", lastReply: { at: Date.now(), kind: primary.kind, text } }, cfg);
        }).catch((error) => {
          // 为什么把错误写进状态:真机对局 m20260919143955 里 134 个回合全部失败,但
          // 表现只是"教练不说话" —— lastReply 停在更早的一次成功、agentStatus 回到 idle。
          // 上层只 console.warn,而 DSH 若不重定向输出,这行日志就永久丢失。
          // 写进 /coach/state 后,"为什么不说话"变成可远程读到的具体原因。
          const msg = String(error?.message ?? error);
          console.warn(`[coach-server] logstream processing error: ${msg}`);
          diagLog(`✗ 回合失败: ${msg}`, cfg);
          updateLiveState({
            agentStatus: "idle",
            lastError: { at: Date.now(), stage: "turn", kind: primary.kind, message: msg }
          }, cfg);
        });
      }

      /** flush 聚合缓冲:把窗口内 observation 合并触发一次回合。
       *  并把"上下文事件"(YOLO/可见性刷新)的最新快照并入,让它们富化本轮但自身不触发。
       *
       *  修复 #1 收尾:OCR 屏幕截图是**低信号源**(技能栏标签 + 玩家名 + 数字混排),
       *  实测纯 OCR 批次里约 3/4 会被模型判定"无战况"而静音 —— 每个都触发回合纯属浪费。
       *  这里对低信号批次做**限流**(LOW_SIGNAL_MIN_MS 内最多触发一次);被限流的事件
       *  不丢弃,而是推迟并入下一次触发(deferred),因此不会漏掉比分这类变化;
       *  含 interaction / brief / 战术标记(空间之灵、防御塔、主宰、击败…)的批次立即触发。 */
      function flushCollect() {
        if (collectTimer) { clearTimeout(collectTimer); collectTimer = null; }
        if (collectBuffer.length === 0) {
          // 只有上下文事件、没有触发源 → 不触发回合(状态已由 liveState 更新)
          return;
        }
        const batch = collectBuffer.splice(0);
        // 聚合窗口内只可能出现同一款游戏的事件:acceptDialogEvent 在 adapter 切换时会先 flush。
        const adapter = batch[0].adapter ?? defaultAdapter;
        const now = Date.now();
        const events = [...(deferredAdapter?.id === adapter.id ? deferredEvents : []), ...batch.map((b) => b.event)];
        // 上下文快照只在"新鲜"时并入(默认 60s),且只并入**同款游戏**的:避免把几分钟前的
        // 小地图/可见性状态一直塞进后续每一轮提示词,也避免跨游戏串味。
        for (const { event, at, adapter: a } of contextOnlyLatest.values()) {
          if (now - (at ?? 0) > CONTEXT_SNAPSHOT_TTL_MS) continue;
          if ((a?.id ?? defaultAdapter.id) !== adapter.id) continue;
          if (!events.includes(event)) events.push(event);
        }
        const high = isHighSignalBatch(events, adapter);
        if (!high && now - lastLowSignalAt < LOW_SIGNAL_MIN_MS) {
          // 低信号批次限流:推迟到下次(不丢事件),状态已由 liveState 更新
          deferredEvents = events.slice(-COLLECT_MAX);
          deferredSourceFile = batch[0].sourceFile;
          deferredAdapter = adapter;
          suppressedLowSignal += 1;
          console.log(`[coach-server] logstream low-signal batch deferred (${events.length} obs, suppressed=${suppressedLowSignal})`);
          return;
        }
        if (!high) lastLowSignalAt = now;
        deferredEvents = [];
        deferredAdapter = adapter;
        submitDialog(events.slice(-COLLECT_MAX), batch[0].sourceFile, adapter);
      }

      /** 事件分层入口:上下文事件只存快照;observation 聚合进 buffer;interaction 立即 flush。
       *  判定全部委托给该事件所属游戏的 adapter.filter 钩子。 */
      function acceptDialogEvent(event, sourceFile, adapter) {
        const a = adapter ?? defaultAdapter;
        // 上下文事件(如 YOLO 检测帧 / 端游局势轮询):只保留最新快照,不单独触发回合
        if (isContextOnly(event, a)) {
          const ctxKey = (filterOf(a).contextKey ? filterOf(a).contextKey(event) : null) || `${event.kind}:${event.key ?? ""}`;
          contextOnlyLatest.set(ctxKey, { event, sourceFile, adapter: a, at: Date.now() });
          return false;
        }
        // 噪音过滤:加载页/菜单/公告/版本号等 OCR 内容、识别失败的小地图 → 不触发对话
        if (!isRelevant(event, a)) return false;
        // 事实指纹门(如 brief:比分/时间/经济/事件词未变)→ 同一事实重复播报,丢弃
        if (!isFactChanged(event, sourceFile, a)) return false;
        // 去重(按游戏分别记指纹,避免两款游戏同文案互相压制)
        const hash = `${a.id}:${event.kind}:${hashText(event.text ?? event.key ?? event.rawMessage)}`;
        const now = Date.now();
        // 去重:同 kind 同内容近期已对话过 → 丢弃
        const last = recentHashes.get(hash);
        if (last !== void 0 && now - last < DEDUPE_MS) return false;
        recentHashes.set(hash, now);
        // 清理过期 hash(防止 Map 无限增长)
        if (recentHashes.size > 500) {
          for (const [k, t] of recentHashes) if (now - t > DEDUPE_MS * 2) recentHashes.delete(k);
        }
        // 聚合窗口内不允许混游戏:换游戏前先把已有窗口 flush 掉
        if (collectBuffer.length > 0 && (collectBuffer[0].adapter?.id ?? defaultAdapter.id) !== a.id) flushCollect();
        // 聚合:进 collecting buffer(保留近窗观察供 interaction 作为上下文)
        collectBuffer.push({ event, sourceFile, adapter: a });
        if (collectBuffer.length >= COLLECT_MAX) { flushCollect(); return true; }
        // interaction(用户显式请求)高优先级:立即 flush(带上近窗 observation)
        if (event.kind === "interaction") { flushCollect(); return true; }
        // observation:重置聚合窗口,空闲 COLLECT_MS 后合并
        if (collectTimer) clearTimeout(collectTimer);
        collectTimer = setTimeout(flushCollect, COLLECT_MS);
        return true;
      }

      // 暂停标志:必须在 createTailer 之前声明(createTailer 会同步 scan 触发 onEvent)
      let dialogPaused = false;
      const tailer = createTailer(cfg.watchDir, (event, sourceFile) => {
        // 暂停时彻底静默:不推送任何刻度,不触发对话
        if (dialogPaused) return;
        // 该事件所属游戏的 adapter(由 ingest.classify 写入 event.game)
        const evAdapter = adapterOfEvent(event, sourceFile);
        // 实时状态快照(前端仪表盘/二维图):保存最新 OCR 帧坐标与小地图
        if (event.kind === "ocr" && event.wordsWithLoc && event.wordsWithLoc.length > 0) {
          const canvas = canvasOf(evAdapter);
          updateLiveState({
            lastOcrFrame: { canvas: { w: canvas.w, h: canvas.h }, words: event.wordsWithLoc }
          }, cfg);
        }
        if (event.kind === "minimap" && event.detail) {
          // YOLO 检测优先(带坐标,供二维图);其余(阵容/身份)存 lastMinimapText,不覆盖 YOLO 检测
          if (event.yolo) {
            updateLiveState({
              lastMinimap: {
                source: event.key,
                roi: event.yolo.roi ?? null,
                detections: event.yolo.detections ?? []
              }
            }, cfg);
          } else {
            updateLiveState({
              lastMinimapText: event.key + (event.text ? ": " + event.text : "")
            }, cfg);
          }
        }
        // 简报 → 解析比分/时间/经济到状态
        if (event.kind === "brief") {
          const t = event.text ?? "";
          const min = t.match(/(\d{1,2})(?:分钟|分)/);
          const score = t.match(/(\d+)\s*vs\s*(\d+)/i) || t.match(/击杀[:：]\s*(\d+)\s*[对vsvs]+\s*(\d+)/i) || t.match(/(\d+)\s*比\s*(\d+)/);
          const eco = t.match(/经济(?:领先|落后)?\s*[约]?\s*(\d+)/) || t.match(/(?:领先|落后)\s*(\d+)\s*经济/);
          if (min || score || eco) {
            updateLiveState({
              gameTime: min ? `${min[1]}分钟` : liveState.gameTime,
              score: score ? `${score[1]}vs${score[2]}` : liveState.score,
              economy: eco ? `相差${eco[1]}` : liveState.economy
            }, cfg);
          }
        }
        // adapter 自带的仪表盘映射:结构化数据源(端游 Live API 等)走这条,
        // 不必把自己的字段硬塞成王者的 OCR 文本形态。返回 null 则不改动状态。
        if (typeof evAdapter?.view?.dashboard === "function") {
          let patch = null;
          try { patch = evAdapter.view.dashboard(event); }
          catch (e) { console.warn(`[coach-server] dashboard 映射失败(${evAdapter.id}/${event.kind}): ${e.message}`); }
          if (patch && typeof patch === "object") {
            const clean = {};
            for (const [k, v] of Object.entries(patch)) if (v !== null && v !== undefined) clean[k] = v;
            if (Object.keys(clean).length) updateLiveState(clean, cfg);
          }
        }
        // 可见进度:App 原播报作为时间轴刻度实时打印
        if (event.kind === "broadcast") {
          broadcastCount += 1;
          const line = `[App原播报 #${broadcastCount}] ${event.text}`;
          console.log(`[coach-server] logstream ${line.slice(0, 80)}`);
          updateLiveState({ lastBroadcast: { at: Date.now(), text: event.text } }, cfg);
          pushMonitor.push(line);
          return;
        }
        // brief_start 参与 brief 拼接:此处 brief 的 text 已含完整简报,直接走对话
        if (event.kind === "brief_start") return;
        // 可对话事件(interaction/brief/ocr/minimap…)→ 去重+防抖后触发 agent 回合
        if (dialogKindsOf(evAdapter).has(event.kind)) {
          acceptDialogEvent(event, sourceFile, evAdapter);
        }
      }, {
        pollMs: cfg.watchPollMs,
        replay: cfg.watchReplay,
        replaySpeed: cfg.watchReplaySpeed,
        // 播报输出文件也住在 watchDir 里:必须排除,否则播报条目会被 tailer 当事件重新消费
        // (它的 kind 字段会被本游戏的 adapter 认出来)→ "播报→新事件→再播报" 反馈环。
        exclude: [basename(cfg.broadcastFile ?? "")].filter(Boolean),
        // 日志行解析交给该行所属游戏的 adapter(内核不含日志格式知识)。
        // 多游戏共用一个 watchDir:三级解析 raw.game → 文件名前缀 <gameId>- → 默认游戏,
        // 命中后把 game id 写回事件,后续过滤/拼装都按这个 adapter 走。
        ingest: {
          classify(raw, file) {
            const a = adapterOfLog(raw, file);
            const ev = a.log.classify(raw, file);
            if (ev && !ev.game) ev.game = a.id;
            return ev;
          },
          eventTime(raw, file) {
            const a = adapterOfLog(raw, file);
            return a.log.eventTime ? a.log.eventTime(raw, file) : null;
          }
        }
      });
      liveTailer = tailer;
      // 暂停/恢复控制器:停止回放排程 + 清空防抖/对话队列
      livePauseController = {
        pause() {
          dialogPaused = true;
          tailer.pause();
          clearCollect();
          // 丢弃已排队未开始的对话回合(否则停止后队列里的 OCR/简报仍会逐个触发)
          liveMonitor?.clearQueue?.();
          updateLiveState({ paused: true, agentStatus: "idle" }, cfg);
          return this;
        },
        resume() {
          dialogPaused = false;
          tailer.resume();
          updateLiveState({ paused: false }, cfg);
          return this;
        },
        replay(file) {
          dialogPaused = false;
          tailer.replayFile(file);
          updateLiveState({ paused: false }, cfg);
          return this;
        },
        isPaused() {
          return dialogPaused;
        }
      };
      console.log(`[coach-server] logstream watching ${cfg.watchDir} (poll ${cfg.watchPollMs}ms)`);
      // ⚠ 启动**默认运行**,不再默认暂停。
      //   原注释是「默认暂停:启动不自动回放/对话,等前端点"开始"」——
      //   它的本意是防止启动时把 watchDir 里的**历史日志**全灌给教练。
      //   但那个职责**已经在正确的层解决了**:logstream.js 里
      //     if (!replay && !offsets.has(file)) { offsets.set(file, size); continue; }
      //   即"非回放模式下第一次见到的文件当作已读完,只跟后续追加"。
      //   于是这条暂停**只剩下一个效果**:让教练静默。
      //   实测代价(2026-09-30 那一局):22 分钟、**0 次云端调用**、coach-live 会话
      //   **0 个回合**,而悬浮窗上**没有任何可见提示** —— 用户以为教练在思考,
      //   实际上它连事件都没收到。而且只有"用户主动提问"才会把它解开
      //   (companion 日志:「提问时发现教练处于暂停 → 自动恢复成功」)。
      //   现在改为默认运行;暂停仍可通过 /coach/control 或 coach_stop_replay 触发。
      livePauseController.resume();
      ctx.effect(() => tailer.stop);
    };
    setTimeout(startTailer, cfg.watchStartDelayMs ?? 5000);
  }
}

/** 创建"coach-live"对局直播教练会话。
 *  真实 agent 会话:interaction 日志事件作为 user 消息触发真实回合(可见思考/工具调用/回复),
 *  broadcast(App原播报)作为时间轴刻度 append 对照。
 *  返回 { push(text), isReady(), submitInteraction(event, sourceFile) }。 */
// ⚠ resolveGame 定义在 apply() 里(不是模块级),所以必须**当参数传进来** ——
//   直接调用会抛 "resolveGame is not defined",而那是 createAgent 阶段,
//   表现为会话建不出来、侧边栏什么都没有(2026-10-02 实测)。
function createMonitor(ctx, cfg, resolveGame) {
  const pendingTexts = [];
  const queue = []; // { body, event, sourceFile, resolve, reject }
  const textQueue = []; // 回合运行期间到达的刻度文本(broadcast 等),回合结束后冲刷
  let session = null;
  let agent = null;
  let running = false;
  // monitor 创建失败时记在这里:后续 submitInteraction 直接快速失败,
  // 而不是把 job 塞进一个永远不会被消费的队列(见 catch 里的说明)。
  let monitorFailed = null;

  const api = {
    push(text) {
      const line = `[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${text}`;
      if (running) {
        // 回合进行中到达的刻度文本:积压,等回合完全展示完再推,避免插队
        textQueue.push(line);
        return;
      }
      if (session === null) {
        pendingTexts.push(line);
        return;
      }
      appendMonitor(session, line);
    },
    isReady() {
      return session !== null && agent !== null;
    },
    /** 健康度快照:给 /coach/state 用。
     *  为什么需要:monitor 挂掉时**所有回合静默消失**(不报错、不播报),
     *  没有这个字段就只能靠"教练怎么不说话"来猜。 */
    health() {
      const now = Date.now();
      const up = session !== null && agent !== null;
      return {
        ready: up,
        failed: monitorFailed ? String(monitorFailed.message ?? monitorFailed) : null,
        queued: queue.length,
        running,
        attempts: startAttempt,
        // 会话从创建到就绪耗时 / 已等待时长:用来区分"正在启动"和"卡死了"
        startMs: up ? readyMs : (startAt ? now - startAt : null),
        // 失败后距离自动重建还有多久(0 表示下一次事件就会重建)
        retryInMs: monitorFailed !== null && retryAt > now ? retryAt - now : 0,
      };
    },
    session() {
      return session;
    },
    /** 提交一个 interaction:进入队列,串行触发 agent 真实回合。返回播报文本 Promise。 */
    submitInteraction(event, sourceFile, body) {
      // 自愈:冷却期已过 → 借这条事件重建会话(否则一次失败会让整个 DSH 生命周期静默)。
      if (monitorFailed !== null && Date.now() >= retryAt) {
        console.warn(`[coach-server] coach-live 重建会话(上次失败: ${monitorFailed.message})`);
        diagLog(`↻ 重建 coach-live 会话(上次失败: ${monitorFailed.message})`, cfg);
        monitorFailed = null;
        startSession();
      }
      // 冷却期内 → **快速失败**,不要塞进死队列。
      // 上层 submitDialog 的 .catch 会打印原因并写进播报文件(空播报+错误可见),
      // 这样"教练不说话"至少有据可查,而不是彻底静默。
      if (monitorFailed) {
        return Promise.reject(new Error(`coach-live 会话不可用: ${monitorFailed.message}`));
      }
      return new Promise((resolve, reject) => {
        queue.push({ event, sourceFile, body, resolve, reject });
        // 队列积压告警:正常情况串行消费不会积压超过几条;
        // 持续增长说明 agent 卡住或未就绪 —— 这时必须出声。
        if (queue.length === 20 || (queue.length > 20 && queue.length % 50 === 0)) {
          console.warn(`[coach-server] ⚠ coach-live 队列积压 ${queue.length} 条` +
            `(agent ${agent ? "已就绪" : "未就绪"}, running=${running})` +
            ` —— 回合可能卡住,检查 monitor 会话`);
        }
        drainQueue();
      });
    },
    /** 清空待处理队列与积压刻度:已排队未开始的回合全部放弃(resolve 空),
     *  当前进行中的回合自然结束后,不会再接续下一个。 */
    clearQueue() {
      for (const job of queue.splice(0)) {
        try { job.resolve(""); } catch { /* noop */ }
      }
      textQueue.length = 0;
    }
  };

  /** 串行消费队列:一次一个 agent 回合,回合结束(coach_reply 回传)后,先冲刷积压的
 *  刻度文本(broadcast 等),再处理下一个 interaction —— 保证"一条事件+完整回合"展示完,
 *  才进下一条,避免上一条没显示完就被插队。 */
  function drainQueue() {
    if (queue.length === 0) {
      // 无对话待处理,冲刷积压刻度
      flushTextQueue();
      return;
    }
    if (running) return;
    if (!agent || typeof agent.send !== "function") {
      // 走到这里说明"会话未就绪":要么还在启动(等下一条事件或 ready 后的 drainQueue),
      // 要么已经失败但队列里还留着 job —— 后者必须结算,否则就是那个静默黑洞。
      if (monitorFailed) {
        for (const job of queue.splice(0)) {
          try { job.reject(monitorFailed); } catch { /* noop */ }
        }
      }
      return;
    }
    // 回合之间:先推积压刻度,再开始下一个对话回合
    flushTextQueue();
    const job = queue.shift();
    running = true;
    // ── 埋点:回合出队(全轨迹的第一个时间点) ──
    const t0 = Date.now();
    let trace = "dequeued";
    const mark = (m) => {
      trace += ` | ${m}@+${Date.now() - t0}ms`;
      try { diagLog(`   · ${m} (+${Date.now() - t0}ms)`, cfg); } catch { /* 埋点不该影响主链路 */ }
    };
    try { diagLog(`▶ 回合出队 kind=${job.event?.kind ?? "?"} key=${job.event?.key ?? "?"} game=${job.body?.game ?? "?"}`, cfg); } catch {}
    const isInit = job.event?.kind === "init";
    const stamp = `[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}]`;
    if (!isInit) {
      // 先把日志事件作为 user 消息 append 进会话(可见:这条日志驱动了本轮对话)。
      // 修复 #5:**只存摘要**。旧实现把整段 job.body.prompt(平均 420 字)再抄一遍,
      // 而同一文本已经在发给模型的 coach 请求体里 —— 属于重复注入上下文(旧日志累计
      // 约 16k 字符纯冗余)。这里压到"事件 key + 上下文 + 首条观察的前 80 字",
      // 仍能让人在会话里看清是什么触发了本轮。
      const contextText = job.event?.context
        ? `(game_time=${job.event.context.game_time ?? "?"}, score=${job.event.context.score ?? "?"})`
        : "";
      const firstObs = String(job.body.prompt ?? "")
        .split("\n")
        .find((l) => l.startsWith("[观察")) ?? "";
      const summary = firstObs.replace(/\s+/g, " ").slice(0, 80);
      const userText = `【日志事件 ${job.event?.key ?? "?"}】${contextText} ${summary}`;
      // ── 埋点:session 到底有没有、append 有没有成功 ──
      mark(`append 前 session=${session ? "有" : "**null**"}`);
      if (session) { appendMonitor(session, `${stamp} [互动] ${userText}`); mark("append 已调用"); }
      else mark("session 为 null → **没写进会话**");
    }
    runAgentTurn(job)
      .then((text) => {
        if (!isInit && session) appendMonitor(session, `${stamp} [DSH播报] ${text || "(静音)"}`);
        job.resolve(text);
      })
      .catch((error) => job.reject(error))
      .finally(() => {
        running = false;
        drainQueue();
      });
  }

  function flushTextQueue() {
    if (textQueue.length === 0 || session === null) return;
    const batch = textQueue.splice(0);
    for (const line of batch) appendMonitor(session, line);
  }

  /** 触发一次真实 agent 回合。
   *  agent.send() 是同步 fire-and-forget(无返回值),所以回合完成的信号不能用它的
   *  返回值。这里轮询 agent.status:send 后先等它进入 running,再等它回到 idle
   *  (此时 turn/end 已写入会话历史、tool result 已持久化),才 resolve、放下一个。
   *  coach_reply 只把最终播报文本记入 liveReplyState,回合结束后读取。 */
  function runAgentTurn(job) {
    // ⚠ 按 game 解析适配器,不要写死 WZRY_ADAPTER ——
    //   写死的后果是玩 LoL 时拿到**王者荣耀的人设与播报规则**(称谓/该看什么全不对)。
    //   别处都是正确解析的(见 resolveGame / adapterOfEvent),只有这里漏了。
    const msg = buildCoachMessage(job.body, resolveGame(job.body?.game));
    // 修复 #6:mark/trace 原定义在 drainQueue() 作用域,这里引用不到 → 定时器每跳
    //   必抛未捕获 ReferenceError 杀死宿主(桌面版打不开)。本函数补一套相同埋点三件套。
    const t0 = Date.now();
    let trace = "turn-start";
    const mark = (m) => {
      trace += ` | ${m}@+${Date.now() - t0}ms`;
      try { diagLog(`   · ${m} (+${Date.now() - t0}ms)`, cfg); } catch { /* 埋点不该影响主链路 */ }
    };
    const state = { text: null };
    liveReplyState = state; // 模块级:coach_reply 工具把播报文本写进来
    liveTextSink.lastText = ""; // 修复 #4:本回合 assistant 文本从零开始记录
    // Phase 2 广播:回合开始时告诉所有 /coach/stream 客户端"思考中"
    sseHub.write("phase", { name: "thinking", text: `回合开始(${job.event?.key ?? "?"})` });
    // 工具广播:监听 tools/result(host 层按 agent 过滤),推工具帧
    let offTools = null;
    offTools = ctx.on("tools/result", (exec, result) => {
      if (!agent || !exec || exec.agent !== agent) return;
      const name = typeof exec.name === "string" ? exec.name : (exec.tool ?? "tool");
      if (name !== "coach_reply") {
        sseHub.write("tool", { name, arguments: exec.arguments ?? exec.args ?? null });
      }
    });
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + (cfg.liveTimeoutMs ?? cfg.deepTimeoutMs ?? 20000) + 5000;
      let phase = "waiting-run"; // waiting-run -> waiting-idle -> done
      let traceSeenStatus = null; // 埋点:只记变化,避免每 100ms 一行
      const timer = setInterval(() => {
        // 加固:定时器内任何未捕获异常都会杀死宿主进程 → 桌面版闪退。整体包 try/catch。
        try {
        if (Date.now() > deadline) {
          clearInterval(timer);
          liveReplyState = null;
          if (offTools) { try { offTools(); } catch {} }
          mark(`**超时** deadline=${cfg.liveTimeoutMs ?? cfg.deepTimeoutMs ?? 20000}+5000ms`);
          try { diagLog(`✗ 回合超时全轨迹: ${trace}`, cfg); } catch {}
          try { updateLiveState({ turnTrace: trace }, cfg); } catch {}
          reject(new Error("coach-live turn timeout"));
          return;
        }
        const s = agent.status; // "running" | "idle"
        if (s !== traceSeenStatus) { traceSeenStatus = s; mark(`agent.status=${s}`); }
        if (phase === "waiting-run") {
          if (s === "running") phase = "waiting-idle";
          else if (s === "idle") {
            // ⚠ 兜底:回合在**首个 tick 之前**就结束了(实测:会话消息非法时,
            //   发送后 ~100ms 就 turn/end with error)。旧逻辑此时永远等不到 running,
            //   于是一路卡到 deadline(实测 125 秒)。send 是同步调用,首个 tick(100ms)
            //   时 agent 要么在跑、要么已结束 → 这里判为"已进入 idle 阶段"是安全的。
            mark("首跳即 idle → 判回合已结束");
          }
          if (s === "idle" || s === "running") { if (phase === "waiting-run") phase = "waiting-idle"; }
        }
        if (phase === "waiting-idle") {
          if (s === "idle") {
            clearInterval(timer);
            if (offTools) { try { offTools(); } catch {} }
            const text = state.text ?? "";
            liveReplyState = null;
            // 修复 #4:模型没调 coach_reply 就结束了回合。此时 assistant 的收尾文本通常是
            // 内部推理("纯状态…已静音处理,请求完成"),直接播报会把推理念给玩家听 ——
            // 所以按静音处理,只记诊断日志(便于发现契约违反)。
            if (state.text === null) {
              // 只记在 console 里等于没记(真机 DSH 未重定向输出)→ 同时写进 /coach/state,
              // "教练全程沉默"至少能区分出"模型没按契约调 coach_reply"这一种原因。
              const tail = String(liveTextSink.lastText || "").slice(0, 60);
              console.warn(`[coach-server] coach-live turn ended without coach_reply (silent). lastText=${JSON.stringify(tail)}`);
              diagLog(`⚠ 回合未调 coach_reply(静音),尾文本: ${tail || "(空)"}`, cfg);
              updateLiveState({
                lastError: { at: Date.now(), stage: "silent", kind: job.event?.kind ?? null, message: `回合结束但未调用 coach_reply(尾文本: ${tail || "(空)"})` }
              }, cfg);
            }
            // Phase 2 广播:播报文本
            if (text) sseHub.write("phase", { name: "speaking", text });
            sseHub.write("done", { response: text });
            mark("回合结束(idle)");
            try { diagLog(`✓ 回合完成轨迹: ${trace}`, cfg); } catch {}
            try { updateLiveState({ turnTrace: trace }, cfg); } catch {}
            resolve(text); // 回合真正结束,取 coach_reply 记录的文本
          }
        }
        } catch (error) {
          try { diagLog(`✗ coach 定时器异常: ${error?.stack ?? error}`, cfg); } catch {}
        }
      }, 100);
      try {
        mark(`send 前 agent=${agent ? agent.status : "**无 agent**"}`);
        agent.send(
          { id: randomUUID(), role: "user", content: [{ type: "text", text: msg }], source: { kind: "user" } },
          "next-turn",
          true
        );
        mark(`send 已返回, agent.status=${agent?.status}`);
      } catch (error) {
        mark(`**send 抛异常**: ${error?.message ?? error}`);
        clearInterval(timer);
        if (offTools) { try { offTools(); } catch {} }
        liveReplyState = null;
        reject(error);
      }
    });
  }

  const monitorId = `coach-live-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  // 与本 agent 的 coach_reply 工具共享的回合状态(修复 #2/#3)
  const liveReplyGuard = { replied: false };
  const liveTextSink = { lastText: "" };
  // 启动看门狗:createAgent 既不 resolve 也不 reject 时(例如 preset mount 卡住),
  // 旧实现让队列无限增长且毫无痕迹 —— 到点即判定失败,让上层拿到明确错误。
  const START_TIMEOUT_MS = cfg.monitorStartTimeoutMs ?? 90000;
  // 失败后允许自愈:冷却期一过,下一条事件会重建会话,而不是让整个 DSH 生命周期内
  // 所有回合永久静默失败(旧实现的实际后果)。
  const RETRY_COOLDOWN_MS = cfg.monitorRetryCooldownMs ?? 30000;
  let startAt = 0;
  let startTimer = null;
  let retryAt = 0;
  let startAttempt = 0;
  let readyMs = null;
  // 初始化回合只入队一次:重建会话时不能重复 unshift,否则每恢复一次就多跑一个 init 回合。
  let initQueued = false;

  /** 创建(或重建)coach-live 会话。失败与超时都收敛到 failMonitor()。 */
  function startSession() {
    startAttempt += 1;
    startAt = Date.now();
    clearTimeout(startTimer);
    startTimer = setTimeout(() => {
      failMonitor(new Error(`createAgent ${Math.round(START_TIMEOUT_MS / 1000)}s 未就绪(无响应,既未 resolve 也未 reject)`));
    }, START_TIMEOUT_MS);
    ctx.agentLoop.createAgent(ctx, {
      sessionId: monitorId,
      meta: { cwd: cfg.sessionCwd, agentPreset: cfg.coachPreset },
      agentOptions: { provider: cfg.provider, model: cfg.model },
      setup: async (agentCtx) => {
        const presets = agentCtx.get("agentPresets");
        if (presets) await presets.mount(agentCtx, cfg.coachPreset);
        // 修复 #2:coach_reply 提交后拒绝同回合的收尾 step(省一次 LLM 往返)
        installReplyStepGuard(agentCtx, liveReplyGuard);
        // 修复 #4:捕获本回合最后一条 assistant 文本(未调 coach_reply 时的兜底播报依据)
        installAssistantTextTap(agentCtx, liveTextSink, cfg);
        // coach_reply:agent 回合结束时把最终播报文本回传(会话持久、全局唯一入口)
        agentCtx.tools.register(makeLiveReplyTool(liveReplyGuard, resolveGame));
      }
    }).then(onMonitorReady).catch(failMonitor);
  }

  function onMonitorReady(published) {
    clearTimeout(startTimer);
    const a = published?.agent ?? published;
    // 返回值形状不对(既没有 send 也没有 status)同样属于"链路断了",
    // 必须在这里拦下 —— 否则又会退化成静默挂起。
    if (!a || typeof a.send !== "function" || a.status === undefined) {
      failMonitor(new Error("createAgent 返回对象缺少 send()/status,无法驱动回合"));
      return;
    }
    agent = a;
    session = a.session;
    readyMs = startAt ? Date.now() - startAt : null;
    startAttempt = 0;
    retryAt = 0;
    // 侧边栏可见性:coach-live 是运行时创建的会话,不会自动进入 workspace 索引,
    // 必须显式 attach 到工作区,否则侧边栏(按 workspace 渲染)看不到它。
    attachSessionToWorkspace(ctx, cfg, monitorId);
    // 侧边栏可见性:给 coach-live 一个固定标题(保留统一显示名,便于辨认)
    const titleSvc = ctx.get("sessionTitle");
    if (titleSvc && session) {
      try {
        titleSvc.rename(session, "对局实时播报 (coach-live)");
      } catch (error) {
        console.warn(`[coach-server] coach-live title rename failed: ${error?.message ?? error}`);
      }
    }
    console.log(`[coach-server] coach-live monitor session ready (id=${monitorId})`);
    diagLog(`✓ coach-live 会话就绪 (id=${monitorId}, ${readyMs ?? "?"}ms)`, cfg);
    for (const text of pendingTexts.splice(0)) appendMonitor(session, text);
    // 侧边栏可见性(关键):DSH 将"从未跑过 agent 回合"的会话视为 blank(空白占位),
    // 客户端 sessionVisible() 会隐藏 blank 会话(只显示当前会话)。coach-live 是纯
    // append 的监控会话,永不自然产生 turn/start → 永远 blank → 侧边栏看不到。
    // 这里把"初始化回合"作为队列的第一个 job 串行执行(产生 turn/start 使 blank=false),
    // 完成后再逐个处理排队中的 interaction 事件。
    // 初始化回合:把"从不跑回合的纯 append 会话"变成非 blank(否则侧边栏看不到),
    // 顺带把会话预热(冷会话首回合实测 >20s,会撞 deepTimeoutMs 被切断 → 静音)。
    // 注意:这里必须用**注册表解析出的游戏 adapter**,不能硬编码某一个游戏 ——
    // 端游(lol)会话套用王者(monitorInit)文案属于跨游戏串味。
    // createMonitor 是顶层函数,拿不到 apply 里的 resolveGame,故从 ctx 取注册表。
    if (!initQueued) {
      initQueued = true;
      const gameReg = typeof ctx.get === "function" ? ctx.get("gameRegistry") : null;
      const initAdapter = gameReg?.resolve?.(cfg.defaultGame ?? "wzry", "wzry") ?? WZRY_ADAPTER;
      const monitorInit = initAdapter.monitorInit ?? WZRY_ADAPTER.monitorInit;
      queue.unshift({
        event: { kind: "init", key: "监控会话初始化" },
        sourceFile: "-",
        body: {
          prompt: monitorInit.prompt,
          system_prompt: monitorInit.system_prompt
        },
        resolve: () => {},
        reject: () => {}
      });
    }
    if (queue.length > 0) drainQueue();
  }

  /** 统一的"会话不可用"出口。三件事缺一不可:
   *  1) 结算队列 —— 否则 job 既不 resolve 也不 reject,上层 .then() 永不触发;
   *  2) 记录原因 —— 供 health()/`/coach/state` 暴露,让"教练不说话"有据可查;
   *  3) 安排自愈 —— 冷却期后由下一条事件触发重建。 */
  function failMonitor(rawError) {
    clearTimeout(startTimer);
    const err = rawError instanceof Error ? rawError : new Error(String(rawError));
    const first = monitorFailed === null;
    monitorFailed = err;
    agent = null;
    session = null;
    retryAt = Date.now() + RETRY_COOLDOWN_MS;
    if (first) {
      // 真机现象(2026-09-19 对局 m20260919143955):monitor 没建起来,而 drainQueue 的
      // 守卫是 `if (!agent) return;` —— agent 永远是 null → 每个 job 既不 resolve 也不
      // reject,134 个回合全部静默消失:没有播报、没有 lastReply、连一条 catch 日志都没有。
      // 从任何指标看都像"教练选择不说话",实际是链路断了 —— 这类静默失效最难发现。
      console.warn(`[coach-server] ⚠ coach-live 会话不可用(第 ${startAttempt} 次尝试): ${err.message}`);
      diagLog(`✗ coach-live 会话不可用(第 ${startAttempt} 次尝试): ${err.message}`, cfg);
      console.warn(`[coach-server] ⚠ 已拒绝队列中 ${queue.length} 个待处理回合;${Math.round(RETRY_COOLDOWN_MS / 1000)}s 后随下一条事件自动重建`);
    }
    for (const job of queue.splice(0)) {
      try { job.reject(err); } catch { /* noop */ }
    }
  }

  startSession();
  return api;
}

/** coach_reply 的 live 版:把最终播报文本记入当前回合的 liveReplyState(不 resolve,
 *  回合结束由 agent.send 控制,避免 tool result 未持久化就进入下一回合) */
let liveReplyState = null;
function makeLiveReplyTool(replyState, resolveGame) {
  // ⚠ 同样不要写死:人设决定工具描述与回复要求(≤50字/称谓等)。
  const persona = (resolveGame(replyState?.game) ?? WZRY_ADAPTER).persona ?? WZRY_ADAPTER.persona;
  return defineTool({
    name: "coach_reply",
    // ⚠ 两种模式(2026-10-01):用户可能在**会话里直接提问**(没有挂起的播报请求)。
    //   那种情况下不要死守"≤50字播报" —— 正常展开回答,再用本工具给出结论。
    description: (persona.replyDescription ?? "输出本次教练请求的最终播报文本(≤50字)。调用后本次请求即完成。")
      + " 注意:如果这一轮是**用户在会话里直接提问**(不是对局事件触发的播报),"
      + "请先展开回答,再用本工具提交结论;此时文本不会截断成播报,会原样显示给用户。",
    parameters: {
      text: { type: "string", required: true, description: persona.replyParamDescription ?? "最终播报文本,可为空字符串(表示静音)" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          // 无挂起请求时,回答正文从这里回显(见 execute 的说明)
          // ⚠ 不要写 `required: false` —— 这个方言要求 required 为 true 或不写,
          //   写 false 会让 createAgent 直接失败(unsupported JSON schema),
          //   表现为"coach-live 会话建不出来 → 侧边栏什么都没有"(2026-10-02 实测)。
          text: { type: "string" }
        }
      },
      // ⚠ 原来固定渲染「播报已提交。」—— 用户在会话里提问时会看到一句"已提交"
      //   却**没有内容**,像是教练没回答。有 text 就显示它。
      render: (_a, v) => [{ type: "text", text: (v && v.text) ? v.text : "播报已提交。" }]
    },
    timeoutMs: 5000,
    isConcurrencySafe: () => true,
    async execute(args) {
      // 修复 #3:同一回合重复调用直接忽略(返回 ok,不改写已提交的播报)
      if (replyState) {
        if (replyState.replied) {
          console.warn(`[coach-server] live coach_reply called again in the same turn; ignoring duplicate`);
          return { ok: true };
        }
        replyState.replied = true;
      }
      const t = typeof args.text === "string" ? args.text : "";
      if (liveReplyState) liveReplyState.text = t;
      // ⚠ 这个工具的文本存进 liveReplyState(监控链路由它取走),不会丢;
      //   但**工具结果里也要带上** —— 用户在会话里看到的是工具结果,
      //   只有 {ok:true} 的话他以为教练什么都没说。
      return { ok: true, text: t };
    }
  });
}

/** 把运行时创建的教练会话显式 attach 到 sessionCwd 对应的工作区(侧边栏可见性)。
 *  带重试:attach 可能因会话持久化未就绪而失败,最多重试 8 次 × 2.5s。 */
async function attachSessionToWorkspace(ctx, cfg, sessionId) {
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const wsRegistry = ctx.get("workspaceRegistry");
      if (!wsRegistry) {
        console.warn(`[coach-server] attach ${sessionId}: workspaceRegistry not available (attempt ${attempt})`);
        await sleep(2500);
        continue;
      }
      const ws = await wsRegistry.resolveByPath(cfg.sessionCwd);
      if (!ws) {
        console.warn(`[coach-server] attach ${sessionId}: no workspace for ${cfg.sessionCwd} (attempt ${attempt})`);
        await sleep(2500);
        continue;
      }
      await ws.attachSession(sessionId);
      // 验证:getter(经 sessionPath 过滤)是否包含该会话
      if (ws.sessionIds.includes(sessionId)) {
        console.log(`[coach-server] attached ${sessionId} to workspace ${ws.record?.path ?? ws.path ?? cfg.sessionCwd} (attempt ${attempt})`);
        return;
      }
      console.warn(`[coach-server] attach ${sessionId}: record updated but getter filtered it out (attempt ${attempt})`);
    } catch (error) {
      console.warn(`[coach-server] attach ${sessionId} failed (attempt ${attempt}): ${error?.message ?? error}`);
    }
    await sleep(2500);
  }
  console.warn(`[coach-server] attach ${sessionId}: gave up after 8 attempts`);
}

function appendMonitor(session, text) {
  try {
    session.append("user/message", {
      id: randomUUID(),
      role: "user",
      content: [{ type: "text", text }],
      // ⚠ v4 校验**明确拒绝** source.kind === "plugin":
      //   写成 plugin 会被判非法 → 污染会话 → 之后每个回合一开就报错,
      //   agent 空转 ~100ms 就 idle(根本没跑模型),用户看到"思考中"干等两分钟。
      //   用 "user" —— 与自己 agent.send 的 kind 一致,那条路径已验证可行。
      source: { kind: "user" }
    }, { surfaceOp: "append" });
  } catch (error) {
    console.warn(`[coach-server] monitor append error: ${error?.message ?? error}`);
  }
}

export { Config, apply, inject, name };
