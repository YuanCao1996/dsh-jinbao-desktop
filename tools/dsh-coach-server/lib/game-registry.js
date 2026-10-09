// game-registry.js — 多游戏适配器注册表(游戏无关)
// ----------
// 内核通过注册表按 `game` 路由;每款游戏注册一个 adapter 对象,内核零游戏知识。
//
// adapter 契约(纯数据 + 纯函数 + 一个状态工厂;实现见 adapters/wzry.js):
//   { id, name, version,
//     persona,        // { systemPrompt, maxReplyTokens, replyDescription, replyParamDescription }
//     deepKeywords,   // 深路径分类关键词
//     monitorInit,    // { prompt, system_prompt } 监控会话初始化
//     view,           // 二维图/仪表盘配置(供 dashboard 按 game 分发)
//     log:    { classify(raw), eventTime(raw) },              // 原始日志行 → 规范化事件
//     filter: { isRelevant, contextOnly, isFactChanged, isHighSignal },  // 事件 → 是否值得对话
//     prompt: { eventToBody, eventsToBody },                  // 事件 → 教练请求体
//     createState() } // 每个日志源的解析状态(如已见英雄、事实指纹)
//
// 新增游戏 = 在 adapters/ 下写一个 adapter 模块并在 apply 里 register。

/** 创建游戏适配器注册表。 */
export function createGameRegistry() {
  const games = new Map(); // id -> adapter
  return {
    register(adapter) {
      if (!adapter || typeof adapter.id !== "string" || !adapter.id) {
        throw new Error(`game-registry: adapter requires a non-empty string id`);
      }
      if (!adapter.log || typeof adapter.log.classify !== "function") {
        throw new Error(`game-registry: adapter "${adapter.id}" requires log.classify`);
      }
      games.set(adapter.id, adapter);
      return adapter;
    },
    get(id) {
      return games.get(id) ?? null;
    },
    /** 解析 game 参数:优先精确匹配,否则回退到默认游戏。 */
    resolve(id, defaultId) {
      return games.get(id) || games.get(defaultId) || null;
    },
    /** 列出所有已注册游戏(供 /coach/state、路由、仪表盘 game 分发)。 */
    list() {
      return [...games.values()].map((a) => ({ id: a.id, name: a.name, version: a.version }));
    }
  };
}

// 内置 adapter:
//   adapters/wzry.js — 王者荣耀(手机 App + adb logcat)
//   adapters/lol.js  — 英雄联盟端游(LCU + Live Client Data + 本地 OCR)
// 这里再导出一次,方便调用方从同一处拿到"注册表 + 参考 adapter"。
export { WZRY_ADAPTER } from "./adapters/wzry.js";
export { LOL_ADAPTER } from "./adapters/lol.js";
