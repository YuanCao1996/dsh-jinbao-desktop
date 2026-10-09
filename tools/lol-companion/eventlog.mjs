// eventlog.mjs — 对局事件日志写入器
// ----------
// 每局一个 jsonl:<watchDir>/lol-<matchId>.jsonl。每行都带 game:"lol",
// 内核(coach-server 的 tailer)据此把行分派给 adapters/lol.js。
// 文件名前缀 lol- 是第二道保险(行内 game 优先)。
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export function createEventLog(watchDir, matchId) {
  if (!existsSync(watchDir)) mkdirSync(watchDir, { recursive: true });
  const safe = String(matchId).replace(/[^\w.-]+/g, "_");
  const file = join(watchDir, `lol-${safe}.jsonl`);
  let count = 0;
  return {
    file,
    /** 写一条事件。自动补 game / t。 */
    append(obj) {
      const line = { game: "lol", t: Date.now(), ...obj };
      try {
        appendFileSync(file, JSON.stringify(line) + "\n", "utf8");
        count += 1;
        return true;
      } catch (e) {
        console.warn(`[eventlog] 写入失败: ${e.message}`);
        return false;
      }
    },
    count() { return count; },
  };
}
