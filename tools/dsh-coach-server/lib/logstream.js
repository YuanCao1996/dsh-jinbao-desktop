// logstream.js — 通用日志流跟踪器(游戏无关)
// ----------
// 监控 watchDir 下的日志文件,按文件维护读取偏移、增量解析、可选 1x 回放排程。
// **本模块不含任何游戏知识**:日志行的解析(classify)与事件时刻(eventTime)
// 由调用方传入的 game adapter 提供(见 adapters/wzry.js),这样换游戏只换 adapter。
//
// 用法:
//   createTailer(watchDir, onEvent, { pollMs, replay, replaySpeed, ingest })
//     ingest = { classify(raw) -> event|null, eventTime(raw) -> ms|null }
import { readdirSync, openSync, readSync, statSync, appendFileSync, closeSync } from "node:fs";
import { join, basename } from "node:path";

/**
 * 创建日志流跟踪器。
 * @param {string} watchDir - 目录
 * @param {(event: object, sourceFile: string) => void} onEvent - 事件回调
 * @param {object} options - {
 *    pollMs: 轮询间隔(默认 2000),
 *    replay: true 时首次整读按日志时间戳排程分发(模拟实时),
 *    replaySpeed: 回放倍速(默认 1x),
 *    ingest: { classify(raw), eventTime(raw) } —— 由 game adapter 提供(必需),
 *    fileSuffix: 只跟踪该后缀的文件(默认 ".jsonl"),
 *    exclude: 要跳过的文件名数组。播报输出文件(coach_broadcasts.jsonl)就在 watchDir 里,
 *             一旦被自己消费就会形成"播报 → 新事件 → 再播报"的反馈环(实测踩到过)。
 *  }
 *   新追加行始终立即分发。
 * @returns {{ stop: () => void, replayFile: (file: string) => void }}
 */
export function createTailer(watchDir, onEvent, options = {}) {
  const pollMs = options.pollMs ?? 2000;
  const replay = options.replay === true;
  const replaySpeed = options.replaySpeed ?? 1;
  const suffix = options.fileSuffix ?? ".jsonl";
  const exclude = new Set((options.exclude ?? []).map((f) => String(f).toLowerCase()));
  const ingest = options.ingest;
  if (!ingest || typeof ingest.classify !== "function") {
    throw new Error("createTailer: options.ingest.classify is required (provided by the game adapter)");
  }
  const classify = ingest.classify;
  const eventTime = typeof ingest.eventTime === "function" ? ingest.eventTime : () => null;

  const offsets = new Map(); // filename -> bytes consumed
  const replayed = new Set(); // files already paced once
  const timers = new Set();
  let stopped = false;
  let paused = false;
  let bootScan = true;
  const partial = new Map();

  const scheduleAt = (event, file, delayMs) => {
    if (delayMs <= 0) {
      onEvent(event, file);
      return;
    }
    const t = setTimeout(() => onEvent(event, file), delayMs);
    timers.add(t);
  };

  const scan = () => {
    if (stopped) return;
    if (paused) return; // 暂停:不读不推进,resume 后从断点继续
    const skipExisting = bootScan; bootScan = false;
    let files;
    try {
      files = readdirSync(watchDir)
        .filter((f) => f.endsWith(suffix))
        .filter((f) => !exclude.has(f.toLowerCase()))
        .sort();
    } catch {
      return; // 目录暂不可用
    }
    for (const file of files) {
      const full = join(watchDir, file);
      let size;
      try {
        size = statSync(full).size;
      } catch {
        continue;
      }
      let consumed = offsets.get(file) ?? 0;
      if (size < consumed) { consumed = 0; offsets.set(file, 0); partial.delete(file); }
      const isFirstScan = consumed === 0;
      // ⚠ 非回放模式(线上)下,**第一次见到的文件直接当作"已读完",只跟后续追加**。
      //   否则每次 coach-server 启动都会把 watchDir 里的历史对局一次性灌给教练:
      //   2026-09-30 实测 —— 历史 3MB(含两局完整日志)全被读入,coach-live 会话
      //   涨到 756KB(压缩),单回合超过 120s 死线、**每个回合都超时**,
      //   用户看到的现象就是"教练页发对话没反应"。
      //   回放模式(replay=true,模拟用)保持原行为:整读 + 按日志时间戳 1x 排程。
      if (!replay && !offsets.has(file) && skipExisting) {
        offsets.set(file, size);
        continue;
      }
      if (size <= consumed) continue;
      // 读新增字节
      let buf;
      let fd;
      try {
        fd = openSync(full, "r");
        buf = Buffer.alloc(Math.min(size - consumed, 1024 * 1024));
        const bytesRead = readSync(fd, buf, 0, buf.length, consumed);
        buf = buf.subarray(0, bytesRead);
      } catch {
        continue;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
      offsets.set(file, consumed + buf.length);
      const combined = Buffer.concat([partial.get(file) ?? Buffer.alloc(0), buf]);
      const end = combined.lastIndexOf(10);
      partial.set(file, combined.subarray(end + 1));
      if (end < 0) continue;
      const text = combined.subarray(0, end).toString("utf8");
      const lines = text.split("\n").filter(Boolean);

      // 模拟实时模式:仅对首次整读按日志时间戳排程;新追加行(真实时)立即分发
      const shouldPace = replay && isFirstScan && !replayed.has(file);
      if (shouldPace) replayed.add(file);
      let fileStartMs = null;

      for (const line of lines) {
        let raw;
        try {
          raw = JSON.parse(line);
        } catch {
          continue;
        }
        // classify/eventTime 额外收到来源文件名:多游戏共存时,内核据此选择该游戏的 adapter
        // (文件名前缀 <gameId>-*.jsonl)。单游戏 adapter 可忽略第二个参数。
        const event = classify(raw, file);
        if (!event) continue;
        if (shouldPace) {
          const t = eventTime(raw, file);
          if (t !== null) {
            if (fileStartMs === null) fileStartMs = t;
            const delay = Math.max(0, (t - fileStartMs) / replaySpeed);
            scheduleAt(event, file, delay);
            continue;
          }
        }
        onEvent(event, file);
      }
    }
  };

  const timer = setInterval(scan, pollMs);
  scan(); // 首次立即扫描(含已有文件)

  /** 手动重置某文件的重放状态:清 offset 与 replayed 标记,下次 scan 重新 1x 排程 */
  const replayFile = (file) => {
    if (!file.endsWith(suffix)) return;
    offsets.delete(file);
    partial.delete(file);
    replayed.delete(file);
    paused = false;
    // 立即触发一次扫描,让该文件重新进入排程
    scan();
  };

  /**
   * 把每个文件的已消费偏移**直接推进到当前大小**(丢弃暂停期间积压的未读字节)。
   *
   * 为什么必须这么做:暂停的语义是"这段时间别说话",而旧实现里暂停只是不扫描、
   * 偏移不推进 —— resume 会把暂停期间的所有事件一次性补放。2026-09-30 实测:
   * 暂停几天后恢复,补放出 79 个回合,会话被灌爆 → 每回合超时 → 教练不回话。
   * 想真正重放历史请用 replayFile()(那是显式动作)。
   */
  const skipBacklog = () => {
    try {
      for (const f of readdirSync(watchDir)) {
        if (!f.endsWith(suffix)) continue;
        try { offsets.set(f, statSync(join(watchDir, f)).size); } catch { /* 文件刚被删/占用 */ }
      }
    } catch { /* 目录暂不可用 */ }
  };

  return {
    /** 暂停:清掉所有排程 timers,扫描不再分发新事件(已读偏移保持,resume 时从断点继续) */
    pause() {
      paused = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
    /** 恢复:先丢弃暂停期间的积压,再从**当前**继续(见 skipBacklog 的说明) */
    resume() {
      skipBacklog();
      paused = false;
      scan();
    },
    isPaused() {
      return paused;
    },
    stop: () => {
      stopped = true;
      clearInterval(timer);
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
    replayFile
  };
}

/** 追加一条广播到输出文件(通用) */
export function appendBroadcast(file, entry) {
  try {
    appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // ignore
  }
}

export { basename };
