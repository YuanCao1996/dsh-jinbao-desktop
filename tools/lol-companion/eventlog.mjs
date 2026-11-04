// eventlog.mjs — 对局事件日志写入器
// ----------
// 每局一个 jsonl:<watchDir>/lol-<matchId>.jsonl。每行都带 game:"lol",
// 内核(coach-server 的 tailer)据此把行分派给 adapters/lol.js。
// 文件名前缀 lol- 是第二道保险(行内 game 优先)。
import { appendFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// Match logs were never pruned: ten days of play left 59 files and 160MB in the state folder.
// Keep the recent ones (the ones a coach session or a bug report actually needs) and drop the
// rest at collector start-up, before this run creates its own file.
export function pruneEventLogs(watchDir, {maxFiles = 40, maxAgeDays = 14, now = Date.now()} = {}) {
  let names = [];
  try { names = readdirSync(watchDir).filter((name) => name.endsWith(".jsonl")); } catch { return {kept: 0, removed: []}; }
  const rows = [];
  for (const name of names) {
    try { const info = statSync(join(watchDir, name)); rows.push({name, at: info.mtimeMs}); } catch {}
  }
  rows.sort((a, b) => b.at - a.at);
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  const removed = [];
  rows.forEach((row, index) => {
    if (index < Math.max(1, maxFiles) && row.at >= cutoff) return;
    try { unlinkSync(join(watchDir, row.name)); removed.push(row.name); } catch {}
  });
  return {kept: rows.length - removed.length, removed};
}

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
