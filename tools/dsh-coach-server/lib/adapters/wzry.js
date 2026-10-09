// adapters/wzry.js — 王者荣耀 adapter(首个参考实现)
// ----------
// 多游戏架构里的"游戏侧内核":所有**王者专属**的日志解析、噪音过滤、事件分级、
// 请求体拼装都集中在这里;内核(coach-server / logstream)保持游戏无关。
//
// 契约(纯数据 + 纯函数 + 一个可选的状态工厂):
//   { id, name, version,
//     persona,            // 人设/播报约束
//     deepKeywords,       // 深路径分类关键词
//     monitorInit,        // 监控会话初始化回合
//     view,               // 二维图/仪表盘配置
//     log:    { classify(raw)->event|null, eventTime(raw)->ms|null },
//     filter: { isRelevant(event)->bool,             // 噪音过滤
//               contextOnly(event, st)->bool,        // 只富化不触发
//               isFactChanged(event, st, src)->bool, // 事实指纹(不变则丢弃)
//               isHighSignal(events, st)->bool },    // 批次信号分级(限流依据)
//     prompt: { eventsToBody(events, opts)->body|null }, // 事件 → 教练请求体
//     createState() }     // 每个日志源一份解析状态

//#region 编码修复
const GBK = new TextDecoder("gbk");

/**
 * 修复 adb 捕获里的 GBK 乱码(UTF-8 字节被 GBK 解码),但**不动**本来正确的 UTF-8。
 * 判定:输入按 UTF-8 取字节、再按 GBK 解码,若该结果按 GBK 重新编码恰好等于
 * 原字节 → 输入是乱码,返回修复结果;否则输入本来就是对的,原样返回。
 */
function fixEncoding(text) {
  try {
    const utf8Bytes = Buffer.from(text, "utf8");
    const gbkDecoded = GBK.decode(utf8Bytes);
    if (Buffer.from(gbkDecoded, "gbk").equals(utf8Bytes)) return gbkDecoded;
    return text;
  } catch {
    return text;
  }
}
//#endregion

//#region 日志行正则(王者 App 的 adb logcat 输出格式)
const INTERACTION_RE = /MOBA局内互动调用LLM:\s*key=([^,]+),\s*context=(.+)$/;
const BROADCAST_RE = /TTS播报已写入对局:.*?\btext=(.+)$/;
const BRIEF_CONTENT_RE = /MOBA_TACTICAL_BRIEF_CONTENT(?:\s+part=\S+)?\s+text=([\s\S]+)$/;
const BRIEF_START_RE = /MOBA_TACTICAL_BRIEF_CONTENT_BEGIN/;
// OCR 识别原始结果(局内文字识别,含经济面板/加载页等)
const OCR_RESULT_RE = /本地OCR识别结果:\s*(\{.*\})/;
// 小地图识别结果:阵容 roster / 身份匹配(识别出英雄)
const MINIMAP_ROSTER_RE = /MINIMAP_HERO_ROSTER\s+(\{.*\})/;
const MINIMAP_IDENTITY_RE = /MINIMAP_IDENTITY_MATCH\s+(\{.*\})/;
// 小地图 YOLO 检测结果:roi + detections(坐标/阵营/英雄)
const MINIMAP_YOLO_RESULT_RE = /MINIMAP_YOLO_RESULT\s+(\{.*\})/;
//#endregion

//#region 噪音过滤规则
// OCR 噪音黑名单:加载页/主界面菜单/公告/版权/版本号/大厅社交/匹配流程等,命中即不触发教练对话
const OCR_NOISE_RE = /加载|进入游戏|准备中|健康系统|背景故事|文网游备字|著作权|出版单位|批准文号|ISBN|粤网文|版本|App\s*v|Build|Res\s*v|R\d{4,}|抵制不良游戏|健康游戏|适龄|实名|虚拟网络|防沉迷|备战|定制|背包|战队|商城|活动|邮件|好友|开黑|跨平台邀请|召集|排位赛|同城|个人中心|观战|赛事|签到|充值|点券|钻石|金币|符文|铭文|皮肤|贵族|排行榜|小队|亲密关系|师徒|荣耀之路|赛季|段位|巅峰积分|扫一扫|退出登录|游戏更新|正在下载|安装|更新包|版本更新|开始游戏|命开房间|人机|匹配|已就绪|确认|点击发消息|领取|兑换|关闭|返回|取消|确定|进行中|等待|约战|邀请|请求帮抢|求助|语音|快捷消息|传说|星元|荣耀典藏|贵族积分|战队赛|巅峰赛|擂台|娱乐|修炼|选将|禁用|扳|召唤师技能|出装预定|备战方案|欢迎来到/i;

// 局内 UI 标签词(技能栏/装备面板/状态栏等)。这些词本身不是战况,OCR 却高频识别到;
// 若一条 OCR 里出现多个不同标签词且去掉后几乎没有剩余汉字,说明它只是界面文字 → 噪音。
const OCR_UI_LABEL_RE = /回城|恢复|伤害|位移|传送阵|净化|闪现|疾跑|治疗|干扰|晕眩|弱化|狂暴|终结|惩击|装备|技能|属性|被动|主动|冷却|金币|商店|设置|投降|交流|快捷|信号|集合|撤退|进攻|防守/i;

// 高信号标记:出现这些词说明是真实战况/资源事件(而非技能栏文字),
// 该批次不再受限流约束、立即触发教练回合。
const HIGH_SIGNAL_RE = /空间之灵|防御塔|主宰|暴君|击败|推塔|团灭|一血|水晶|高地|先锋|反超|扳平|团战|开团|越塔|抢龙|打龙|rush/i;

// brief 事实指纹有效期:超时后强制重估(防漏掉长间隔变化)
const BRIEF_FP_EXPIRE_MS = 120000;
//#endregion

//#region 人设与配置
const PERSONA_SYSTEM_PROMPT = "你是王者荣耀游戏助手金宝,分析时基于游戏理解和团队原则,给玩家建议时可带上游戏理解和团队原则作为依据。";

function formatYolo(parsed) {
  if (!parsed) return "";
  const dets = parsed.detections ?? [];
  if (dets.length === 0) return "小地图: 无检测";
  const parts = dets.map((d) => `${d.team === "ALLY" ? "我方" : "敌方"}${d.direct_hero ?? "?"}(${(d.x ?? 0).toFixed(0)},${(d.y ?? 0).toFixed(0)})`);
  return `小地图识别 ${dets.length} 个: ${parts.join(" ")}`;
}
//#endregion

//#region 日志解析(log:原始行 → 规范化事件)
/**
 * 解析一行日志,返回规范化事件或 null。
 * 事件类型:interaction / broadcast / brief / brief_start / ocr / minimap
 */
function classify(raw) {
  const tag = fixEncoding(raw.tag ?? "");
  const message = fixEncoding(raw.message ?? "");
  if (!message) return null;

  // 局内互动 → 教练请求(带 context JSON)
  const interaction = message.match(INTERACTION_RE);
  if (interaction) {
    let context = null;
    try {
      context = JSON.parse(interaction[2]);
    } catch {
      context = null;
    }
    return {
      kind: "interaction",
      key: interaction[1],
      context,
      rawMessage: message,
      time: raw.timestamp ?? raw.captured_at_local ?? null
    };
  }

  // App 实际播报(对照/评估)
  const broadcast = message.match(BROADCAST_RE);
  if (broadcast) {
    return { kind: "broadcast", text: broadcast[1].trim(), time: raw.timestamp ?? null };
  }

  // 实时事实简报内容(状态,拼接用)
  if (BRIEF_START_RE.test(message)) return { kind: "brief_start", time: raw.timestamp ?? null };
  const brief = message.match(BRIEF_CONTENT_RE);
  if (brief) return { kind: "brief", text: brief[1].trim(), time: raw.timestamp ?? null };

  // OCR 识别原始结果(局内文字识别)
  const ocr = message.match(OCR_RESULT_RE);
  if (ocr) {
    let words = null;
    let wordsWithLoc = null;
    try {
      const parsed = JSON.parse(ocr[1]);
      words = (parsed.words_result ?? []).map((w) => w.words).filter(Boolean);
      wordsWithLoc = (parsed.words_result ?? [])
        .filter((w) => w.words && w.location)
        .map((w) => ({ text: w.words, ...w.location }));
    } catch {
      words = null;
      wordsWithLoc = null;
    }
    return {
      kind: "ocr",
      key: tag || "OCR",
      text: words ? words.join(" | ") : message.slice(0, 300),
      words,
      wordsWithLoc,
      rawMessage: message,
      time: raw.timestamp ?? raw.captured_at_local ?? null
    };
  }

  // 小地图识别结果:YOLO 检测(带坐标/阵营/英雄,二维图主数据源)
  const yolo = message.match(MINIMAP_YOLO_RESULT_RE);
  if (yolo) {
    let parsed = null;
    try {
      parsed = JSON.parse(yolo[1]);
    } catch {
      parsed = null;
    }
    return {
      kind: "minimap",
      key: "小地图YOLO检测",
      text: formatYolo(parsed),
      yolo: parsed,
      detail: parsed,
      rawMessage: message,
      time: raw.timestamp ?? raw.captured_at_local ?? null
    };
  }

  // 小地图识别结果:阵容
  const roster = message.match(MINIMAP_ROSTER_RE);
  if (roster) {
    let parsed = null;
    try {
      parsed = JSON.parse(roster[1]);
    } catch {
      parsed = null;
    }
    return {
      kind: "minimap",
      key: "小地图阵容",
      text: parsed ? `阵容: ${parsed.roster ?? JSON.stringify(parsed)}` : message.slice(0, 300),
      detail: parsed,
      rawMessage: message,
      time: raw.timestamp ?? raw.captured_at_local ?? null
    };
  }

  // 小地图识别结果:英雄身份匹配
  const identity = message.match(MINIMAP_IDENTITY_RE);
  if (identity) {
    let parsed = null;
    try {
      parsed = JSON.parse(identity[1]);
    } catch {
      parsed = null;
    }
    return {
      kind: "minimap",
      key: `小地图识别: ${parsed?.hero ?? "英雄"}`,
      text: parsed ? `识别到英雄 ${parsed.hero ?? "?"}: 队伍=${parsed.team ?? "?"} 状态=${parsed.state ?? "?"}` : message.slice(0, 300),
      detail: parsed,
      rawMessage: message,
      time: raw.timestamp ?? raw.captured_at_local ?? null
    };
  }

  return null;
}

/** 从原始日志行提取事件时刻(优先 captured_at_local ISO)——回放 1x 排程用 */
function eventTime(raw) {
  const iso = raw.captured_at_local;
  if (typeof iso === "string") {
    const t = Date.parse(iso);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}
//#endregion

//#region 过滤与分级(filter:事件 → 是否值得对话)
/**
 * 判断一条事件是否值得触发教练对话(噪音过滤)。
 *
 * 历史修复(测试日志暴露,已固化):
 *  1. 散字判定在**原文**上取连续汉字串 —— 旧实现先去掉分隔符再匹配,
 *     会把 "司 | 雅" 拼成 "司雅" 当成词,导致纯垃圾 OCR 也触发回合。
 *  2. UI 标签词过滤:≥2 个不同标签且去掉后剩余汉字过少 → 界面文字,非战况。
 *  3. YOLO 检测帧只喂状态不触发(contextOnly 处理)。
 *  4. 英雄识别的可见性刷新交给 contextOnly 按"首次出现"判定;
 *     hero 为空/识别失败的整条丢弃(曾因 key 精确比较写错而漏进提示词)。
 */
function isRelevant(event) {
  if (!event) return false;
  if (event.kind === "ocr") {
    const text = event.text ?? "";
    if (!text) return false;
    const cjkRuns = text.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
    const totalCjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
    if (cjkRuns.length === 0 && totalCjk < 4) return false; // 碎片
    if (totalCjk < 4) return false;
    if (OCR_NOISE_RE.test(text)) return false;
    const labelHits = new Set((text.match(new RegExp(OCR_UI_LABEL_RE.source, "gi")) ?? []).map((s) => s));
    if (labelHits.size >= 2) {
      const withoutLabels = text.replace(new RegExp(OCR_UI_LABEL_RE.source, "gi"), "");
      const remainCjk = (withoutLabels.match(/[\u4e00-\u9fff]/g) ?? []).length;
      if (remainCjk < 4) return false;
    }
    return true;
  }
  if (event.kind === "minimap") {
    const d = event.detail ?? {};
    const key = String(event.key ?? "");
    // YOLO 检测帧 = 二维图数据源,高频;只更新状态,不单独触发对话
    if (key === "小地图YOLO检测") return false;
    // 英雄识别(实际 key 是 `小地图识别: <hero>`)
    if (/^小地图识别/.test(key)) {
      if (d.accepted === false || d.reason === "hero_not_in_match_roster") return false;
      if (!d.hero || !String(d.hero).trim()) return false;
      return true;
    }
    // 阵容需有内容
    if (key === "小地图阵容" && !String(event.text ?? "").includes("allies")) return false;
    return true;
  }
  if (event.kind === "brief") {
    const text = event.text ?? "";
    if (!text) return false;
    if (!/击杀|经济|比分|分钟|推塔|主宰|暴君|死亡|人头|兵线|视野|防御塔/.test(text)) return false;
    return true;
  }
  return true;
}

/**
 * "上下文事件":只**富化**同一窗口的触发回合,自身不触发。王者里有两类高频噪音:
 *   · 小地图 YOLO 检测帧(二维图数据源,每 2s 一帧)
 *   · "小地图识别: 英雄" 的可见性刷新(VISIBLE/LAST_SEEN 反复切换)
 * 英雄**首次出现**仍是触发源("镜现身"这类有价值播报来自它)。
 */
function contextOnly(event, st) {
  if (event.kind !== "minimap") return false;
  const key = String(event.key ?? "");
  if (key === "小地图YOLO检测") return true;
  if (/^小地图识别/.test(key)) {
    const hero = event.detail?.hero;
    if (!hero || !String(hero).trim()) return false; // 交给 isRelevant 丢弃
    if (!st.seenHeroes.has(hero)) {
      st.seenHeroes.add(hero);
      return false; // 首次出现 → 触发源
    }
    return true; // 后续可见性刷新 → 仅上下文
  }
  return false;
}

/** 提取简报事实指纹:分钟|比分|经济(百位下限)|关键事件词。同一指纹 = 同一事实重复播报。 */
function briefFingerprint(text) {
  const t = String(text ?? "");
  const min = (t.match(/(\d{1,2})(?:分钟|分)/) || [])[1] ?? "0";
  const score = (t.match(/(\d+)\s*vs\s*(\d+)/i)
    || t.match(/击杀[:：]\s*(\d+)\s*[对vsvs]+\s*(\d+)/i)
    || t.match(/(\d+)\s*比\s*(\d+)/)
    || [])[0] ?? "?";
  const ecoM = t.match(/经济(?:领先|落后)?\s*[约]?\s*(\d+)/) || t.match(/(?:领先|落后)\s*(\d+)\s*经济/);
  let eco = "?";
  if (ecoM) eco = String(Math.floor(parseInt(ecoM[1], 10) / 100) * 100);
  const evMatch = t.match(/(推塔|主宰|暴君|死亡|英雄|高地|水晶|防御塔|击杀|反超|扳平)/g);
  const ev = evMatch ? [...new Set(evMatch)].sort().join(",") : "";
  return `${min}|${score}|${eco}|${ev}`;
}

/** 事实是否变化:brief 指纹未变(且未超有效期)→ 同一事实重复播报,不值得再触发。 */
function isFactChanged(event, st, sourceFile) {
  if (event.kind !== "brief") return true; // 只有简报做事实指纹
  const fp = briefFingerprint(event.text ?? "");
  const now = Date.now();
  const last = st.briefFp.get(sourceFile);
  if (last && now - last.at < BRIEF_FP_EXPIRE_MS && last.fp === fp) return false;
  st.briefFp.set(sourceFile, { fp, at: now });
  if (st.briefFp.size > 200) {
    for (const [k, v] of st.briefFp) if (now - v.at > BRIEF_FP_EXPIRE_MS * 2) st.briefFp.delete(k);
  }
  return true;
}

/** 批次是否含"高信号":局内互动 / 事实简报 / 阵容 / 带战术标记的 OCR。 */
function isHighSignal(events, st) {
  return events.some((ev) => {
    if (!ev) return false;
    if (ev.kind === "interaction" || ev.kind === "brief") return true;
    if (ev.kind === "minimap" && /阵容/.test(String(ev.key ?? ""))) return true;
    if (ev.kind === "ocr" && HIGH_SIGNAL_RE.test(String(ev.text ?? ""))) return true;
    return false;
  });
}

/** 上下文快照的归并键:同类事件只保留最新一条(YOLO 帧单槽,英雄识别按英雄分槽)。 */
function contextKey(event) {
  const key = String(event.key ?? "");
  if (key === "小地图YOLO检测") return "yolo";
  return `mm:${key}`;
}
//#endregion

//#region 请求体拼装(prompt:事件 → 教练请求体)
/** 事件 → 教练请求体(单事件版,保留给需要逐条构建的场景)。 */
function eventToBody(event, opts = {}) {
  const commonSystem = opts.systemPrompt || PERSONA_SYSTEM_PROMPT;
  switch (event.kind) {
    case "interaction":
      return {
        prompt: `context=${JSON.stringify(event.context ?? {})}\n请基于以上游戏上下文给出简短播报建议(≤50字)。`,
        system_prompt: commonSystem,
    // ⚠ 不要写死 model(原先这里写着 qwen3.6-plus,**没有任何地方读它**)。
    //   真正生效的是 coach-server 配置里的 cfg.provider / cfg.model;
    //   实际全部云端调用都是 opencode-go / deepseek-v4.1-flash。
      };
    case "brief":
      return {
        prompt: `【实时事实简报】\n${event.text}\n\n请基于简报中的实时对局事实,给出下一步的简短播报建议(≤50字);若是纯状态无变化可输出空串。`,
        system_prompt: commonSystem,
    // ⚠ 不要写死 model(原先这里写着 qwen3.6-plus,**没有任何地方读它**)。
    //   真正生效的是 coach-server 配置里的 cfg.provider / cfg.model;
    //   实际全部云端调用都是 opencode-go / deepseek-v4.1-flash。
      };
    case "ocr":
      return {
        prompt: `【OCR识别结果】\n${event.text}\n\n请基于识别到的局内文字(经济面板/比分/提示等),给出简短播报建议(≤50字);若是不相关杂项(加载页/公告/版本号)输出空串。`,
        system_prompt: commonSystem,
    // ⚠ 不要写死 model(原先这里写着 qwen3.6-plus,**没有任何地方读它**)。
    //   真正生效的是 coach-server 配置里的 cfg.provider / cfg.model;
    //   实际全部云端调用都是 opencode-go / deepseek-v4.1-flash。
      };
    case "minimap":
      return {
        prompt: `【小地图识别结果】\n${event.text}\n\n请基于识别到的阵容/英雄信息,给出简短播报建议(≤50字);若是初始/无变化状态输出空串。`,
        system_prompt: commonSystem,
    // ⚠ 不要写死 model(原先这里写着 qwen3.6-plus,**没有任何地方读它**)。
    //   真正生效的是 coach-server 配置里的 cfg.provider / cfg.model;
    //   实际全部云端调用都是 opencode-go / deepseek-v4.1-flash。
      };
    default:
      return null;
  }
}

/** 事件 → 教练请求体(聚合版):把窗口内多个 observation 合并成一个请求体,单回合分析。 */
function eventsToBody(events, opts = {}) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const commonSystem = opts.systemPrompt || PERSONA_SYSTEM_PROMPT;
  // interaction(用户显式请求)优先;其余按到达顺序
  const ordered = [...events].sort((a, b) => {
    const pa = a.kind === "interaction" ? 0 : 1;
    const pb = b.kind === "interaction" ? 0 : 1;
    return pa - pb;
  });
  const lines = ordered.map((ev, i) => {
    const tag = { interaction: "局内互动", brief: "实时简报", ocr: "OCR识别", minimap: "小地图" }[ev.kind] ?? ev.kind;
    const content = ev.kind === "interaction"
      ? (ev.context?.content ?? ev.rawMessage ?? ev.text ?? "")
      : (ev.text ?? ev.key ?? ev.rawMessage ?? "");
    return `[观察${i + 1}·${tag}${ev.key ? `(${ev.key})` : ""}] ${String(content).slice(0, 400)}`;
  });
  return {
    // 注意:不要在这里写"合并 N 条"这类**裸数字** —— 它是内部计数、与对局无关,
    // 却会成为观察文本里的第一个数字,容易被模型误当作比分读取。
    prompt: `【实时对局观察(按时间先后排列)】\n${lines.join("\n")}\n\n请基于以上实时观察,给出下一步的简短播报建议(≤50字);若均为纯状态无变化可输出空串。`,
    system_prompt: commonSystem,
    // ⚠ 不要写死 model(原先这里写着 qwen3.6-plus,**没有任何地方读它**)。
    //   真正生效的是 coach-server 配置里的 cfg.provider / cfg.model;
    //   实际全部云端调用都是 opencode-go / deepseek-v4.1-flash。
    _count: events.length
  };
}
//#endregion

/** 王者荣耀 adapter —— 首个参考实现。 */
export const WZRY_ADAPTER = {
  id: "wzry",
  name: "王者荣耀",
  version: 1,
  persona: {
    systemPrompt: PERSONA_SYSTEM_PROMPT,
    maxReplyTokens: 50,
    replyDescription: "输出本次教练请求的最终播报文本(≤50字)。调用后本次请求即完成。",
    replyParamDescription: "最终播报文本,可为空字符串(表示静音)"
  },
  deepKeywords: ["经济面板", "死亡回放", "战绩", "阵容", "出装", "攻略", "复盘", "简报", "梯队", "梯度", "克制"],
  monitorInit: {
    prompt: "监控会话初始化,请只回复\"就绪\"二字。",
    system_prompt: "你是王者荣耀游戏助手金宝的监控会话,回复极简。"
  },
  // 兼容字段:请求体默认人设(内核不再硬编码)
  eventToBodySystemPrompt: PERSONA_SYSTEM_PROMPT,
  view: {
    ocrCanvas: { w: 3200, h: 1440 },
    minimapRoi: { left: 151, top: 0, width: 468, height: 468 }
  },
  /** 可触发教练对话的事件类型(内核调度器用它过滤) */
  dialogKinds: new Set(["interaction", "brief", "ocr", "minimap"]),
  log: { classify, eventTime },
  filter: { isRelevant, contextOnly, isFactChanged, isHighSignal, contextKey },
  prompt: { eventToBody, eventsToBody },
  /** 每个日志源一份解析状态(英雄首次出现、brief 事实指纹) */
  createState() {
    return { seenHeroes: new Set(), briefFp: new Map() };
  }
};
