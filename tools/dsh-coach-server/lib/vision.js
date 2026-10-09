// vision.js — 画面理解兜底(用云端**多模态**模型看截图)
// ----------
// 为什么需要它:
//   本地识别链(PP-OCRv6 + 模板匹配 + 像素法)在几类场景下**根本读不出来**:
//     · 加载页只有十几秒,窗口化截图里左栏文字常整块丢失;
//     · 选人/结算页版式随分辨率与窗口模式变化,ROI 会漂;
//     · 游戏模式、当前阶段这类"整屏语义",OCR 拿到的是一堆无结构文字,
//       要靠版式规则去猜 —— 猜错的代价是后面整条建议链针对错对象;
//     · OCR 只认它见过的字形,皮肤名/称号/花体字经常读成别的字。
//   这些恰好是**多模态模型擅长、规则很难覆盖**的部分。
//
// 设计原则(每一条都对应一次真实的错误教训):
//   1. **结构化输出**:返回固定字段的 JSON,调用方按字段用,不要解析散文。
//   2. **不知道就说不知道**:每个字段都允许 null,并要求模型给出 confidence 与
//      不确定项。宁可返回 null 让上层走旧逻辑,也不能编一个看起来合理的答案 ——
//      编出来的"敌方阵容"会让后续所有针对性建议全错,且看不出异常。
//   3. **不替代本地链路**:本地能读出来的就以本地为准(更快、免费、可复现)。
//      这里只做**兜底与交叉验证**。
//   4. **一次调用回答所有问题**:游戏/模式/阶段/我是谁/双方阵容/局势 ——
//      同一张图问五遍是五倍成本,而模型看一次就能全答。
//
// ⚠ 关于模型能力:provider/model 来自 coach-server 配置,当前是
//   opencode-go / deepseek-v4.1-flash —— 它在模型目录里声明了
//   `input: ["text","image"]`,即**支持图像输入**。换模型时必须确认这一点,
//   否则图片会被静默降级成文本占位符(见 dsh-llm 的 textOnlyImageText)。

import { readFileSync } from "node:fs";
import { basename } from "node:path";

/** 支持的图片格式(与 dsh-attachment 的 ImageMediaType 一致)。 */
const MEDIA_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function mediaTypeOf(path) {
  const m = /\.([a-z0-9]+)$/i.exec(String(path ?? ""));
  return m ? MEDIA_BY_EXT[`.${m[1].toLowerCase()}`] ?? null : null;
}

/**
 * 提示词。**核心设计**:模型只做「抄写」,不做「翻译」。
 *
 * ⚠ 这条是被真机实测逼出来的(2026-09-19):
 *   最初让模型直接给"英雄正式名",它对着一张加载页截图:
 *     · 把 10 个皮肤名/称号**全部抄对了**(双界灵兔、不破之誓、苍穹之光 维克兹…),
 *     · 但自己做的"皮肤名 → 英雄名"映射**错了 3 个**:
 *         双界灵兔 → 说「亚索」,实际是「阿萝拉」
 *         不破之誓 → 说「乐芙兰」,实际是「芸阿娜」
 *         不落魔锋 → 说「蔚」,  实际是「亚恒」
 *       而本地的英雄表能把这 10 个**全部**解对(0 错)。
 *   结论:视觉模型擅长**看字**,不擅长**查表**。所以分工改成:
 *     模型负责「图里写了什么」(raw 文本),本地负责「这是什么」(查表)。
 *   这同时消除了模型编造英雄名的风险 —— 它抄错字我们能纠(本地有 OCR 纠错),
 *   它编一个不存在的英雄我们只能靠运气发现。
 */
const SYSTEM_PROMPT = [
  "你是游戏画面**抄写**模块。看一张游戏截图,把图上**实际印着的字**抄下来,输出严格 JSON",
  "(不要 markdown 代码块、不要解释)。",
  "",
  "⚠ 最重要的规则:**照抄,不要翻译、不要解释、不要推断**。",
  "· 图上写「双界灵兔」就抄「双界灵兔」—— **不要**写成「阿萝拉」,即使你知道那是她的称号。",
  "· 图上写「苍穹之光 维克兹」就原样抄,不要简化成「维克兹」。",
  "· 认不出的字用「?」占位,不要用你猜的字填上。",
  "抄写比「认出来」更可靠:你不需要知道那是什么英雄,只需要把字看清楚。",
  "",
  "看不清、被遮挡、或图里没有该信息时,该字段填 null,并把原因写进 uncertain。",
  "**绝对不要编造** —— 这份结果会被用来给出针对性建议,编错会让建议全错,而且表面看不出来。",
  "",
  "输出字段:",
  "{",
  '  "game": "英雄联盟" | "王者荣耀" | "其它" | null,   // 哪款游戏(这个可以直接判断)',
  '  "screen": "选人" | "加载" | "局内" | "结算" | "大厅" | "未知",  // 哪个阶段(直接判断)',
  '  "mode": string | null,        // 模式名,如 "海克斯大乱斗"/"极地大乱斗";图上看不出就 null',
  '  "names": string[] | null,     // ⭐ 图上出现的**所有英雄名字**,按阅读顺序逐个照抄',
  '                                //   (从上到下、每行从左到右)。这是最重要的字段。',
  '  "rows": string[][] | null,    // 若画面明显分成**多行**(如加载页上下两排),按行给出;',
  '                                //   每行内从左到右。**只按位置分行,不要判断哪行是我方**。',
  '  "me": {                       // 我操作的英雄 —— 仅当画面上**确实能看出**时填',
  '    "champion": string | null,  //   填图上印的那个名字(可能是称号);看不出就整个 me 填 null',
  '    "level": number | null,',
  '    "kda": string | null,       // 形如 "3/2/11"',
  '    "gold": number | null',
  '  } | null,',
  '  "state": string | null,       // 一句话局势:比分/经济差/是否团战中/是否阵亡',
  '  "confidence": number,         // 0~1,你对本次整体判断的把握',
  '  "uncertain": string[]         // 哪些字段没把握、为什么',
  "}",
  "",
  "注意:",
  "· **不要**把字段叫成「我方/敌方」去思考 —— 你不需要知道谁是敌方。",
  "  只回答「图上印了哪些名字、它们分别在第几行」。哪边是我方由本地程序按选人阵容判定,",
  "  你判错会把双方阵容整份颠倒,比不判更糟。",
  "· 若画面里能**直接**看出阵营(例如血条颜色、队伍分组),写进 uncertain 说明,但不要据此改变字段。",
  "· 如果画面里有多个英雄而你看不出哪个是我,me 填 null 并写进 uncertain。",
].join("\n");

const USER_PROMPT = "把这张截图上的文字抄下来。";

/** 从模型输出里抠出 JSON —— 它可能裹在 ```json 里,也可能前后带解释。 */
export function extractJson(text) {
  const s = String(text ?? "").trim();
  if (!s) return null;
  // 优先整段就是 JSON
  try { return JSON.parse(s); } catch { /* 继续 */ }
  // 去掉 markdown 代码块围栏
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch { /* 继续 */ } }
  // 退而求其次:取第一个平衡的 {...}
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } }
    }
  }
  return null;
}

/** 把模型输出规整成固定形状:缺字段补 null,类型不对就丢弃(不硬转)。 */
export function normalizeVision(raw) {
  if (!raw || typeof raw !== "object") return null;
  const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const list = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : null);
  const meRaw = raw.me && typeof raw.me === "object" ? raw.me : null;
  const me = meRaw ? {
    champion: str(meRaw.champion),
    level: num(meRaw.level),
    kda: str(meRaw.kda),
    gold: num(meRaw.gold),
  } : null;
  const out = {
    game: str(raw.game),
    screen: str(raw.screen) ?? "未知",
    mode: str(raw.mode),
    me: me && (me.champion || me.level != null || me.kda || me.gold != null) ? me : null,
    // ⭐ names/rows 是**抄写结果**,不带任何阵营含义(见提示词里的说明:
    //   字段名本身不能暗示"我方/敌方",否则模型会因为"判不出哪排是我方"
    //   而把整个字段填 null —— 那样连抄下来的名字都丢了。实测踩过。)
    names: list(raw.names),
    rows: Array.isArray(raw.rows) ? raw.rows.map(list).filter((r) => r && r.length) : null,
    state: str(raw.state),
    confidence: num(raw.confidence) ?? 0,
    uncertain: Array.isArray(raw.uncertain) ? raw.uncertain.map(str).filter(Boolean) : [],
  };
  // 兼容旧字段名(模型偶尔仍按旧 schema 输出 allies/enemies)
  if (!out.names?.length && !out.rows?.length) {
    const legacy = [...(list(raw.allies) ?? []), ...(list(raw.enemies) ?? [])];
    if (legacy.length) out.names = legacy;
  }
  // "全空"要如实反映成低置信度,不能因为字段齐全就显得可信
  const anyFact = out.game || out.mode || out.me || out.names?.length || out.rows?.length || out.state;
  if (!anyFact) out.confidence = Math.min(out.confidence, 0.1);
  return out;
}

/**
 * 创建画面分析器。
 *
 * @param ctx  DSH 插件上下文(需要 llm 与 attachments 服务)
 * @param cfg  { provider, model, visionTimeoutMs }
 */
export function createVision(ctx, cfg) {
  const enabled = () => cfg.visionEnabled !== false;
  const timeoutMs = () => cfg.visionTimeoutMs ?? 20000;

  /**
   * 分析一张本地图片。
   * @param imagePath 本地绝对路径(png/jpg/webp/gif)
   * @param opts.extra 追加给模型的提示(例如"这一帧 LCU 说是加载页,请重点确认双方阵容")
   * @returns { ok, data?, error?, ms }  —— **永不抛异常**,调用方按 ok 判断
   */
  async function analyze(imagePath, opts = {}) {
    const t0 = Date.now();
    if (!enabled()) return { ok: false, error: "vision disabled", ms: 0 };
    const mediaType = mediaTypeOf(imagePath);
    if (!mediaType) return { ok: false, error: `unsupported image type: ${imagePath}`, ms: 0 };
    const llm = ctx.get("llm");
    if (!llm) return { ok: false, error: "llm service unavailable", ms: 0 };
    const attachments = ctx.get("attachments");
    if (!attachments) return { ok: false, error: "attachments service unavailable", ms: 0 };

    let bytes;
    try {
      bytes = readFileSync(imagePath);
    } catch (e) {
      return { ok: false, error: `read failed: ${e.message}`, ms: Date.now() - t0 };
    }

    // 图片必须先经过 attachment 服务**校验并归一化**才能进 content block:
    // 直接把字节塞进消息里,模型侧拿到的是未校验数据,格式/尺寸问题会在很远处才暴露。
    let ref;
    try {
      ref = await attachments.saveImage({ data: bytes, mediaType, name: basename(imagePath) });
    } catch (e) {
      return { ok: false, error: `attachment refused: ${e.message}`, ms: Date.now() - t0 };
    }

    const userText = opts.extra ? `${USER_PROMPT}\n补充线索: ${opts.extra}` : USER_PROMPT;
    const messages = [
      { role: "system", content: [{ type: "text", text: SYSTEM_PROMPT }] },
      { role: "user", content: [
        { type: "text", text: userText },
        { type: "image", attachment: ref },
      ] },
    ];

    let text = "";
    try {
      const signal = AbortSignal.timeout(timeoutMs());
      const call = await llm.prepareCall({
        provider: cfg.provider,
        model: cfg.model,
        messages,
        maxTokens: 900,
      }, signal);
      for await (const chunk of call.stream(call.config)) {
        if (chunk.type === "text-delta") text += chunk.text;
      }
    } catch (e) {
      return { ok: false, error: `llm call failed: ${e.message}`, ms: Date.now() - t0 };
    }

    const parsed = extractJson(text);
    const data = normalizeVision(parsed);
    if (!data) {
      return { ok: false, error: "model did not return usable JSON", raw: text.slice(0, 400), ms: Date.now() - t0 };
    }
    return { ok: true, data, raw: text.slice(0, 800), ms: Date.now() - t0 };
  }

  return { analyze, systemPrompt: SYSTEM_PROMPT };
}
