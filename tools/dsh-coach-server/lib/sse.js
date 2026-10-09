// sse.js — Phase 2:SSE 统一信封 + 断线续接
// ----------
// `/ai/stream` 返回 text/event-stream,每帧一个信封:
//   { type: "phase"|"tool"|"custom"|"done"|"error"|"cancel",
//     seq: N,   // 自增序号(断线续接依据)
//     ts: ms,   // 帧时间戳
//     data: {}  // 帧负载:phase={name,text?} tool={name,arguments?,result?} done={response} error={message} }
// 断线续接:客户端重连带 lastSeq=N,服务端从 seq>N 重放缓冲中已有的帧,再继续推进。

/** 把数据写成一个 SSE 数据帧(多行 JSON 需转义换行 — JSON.stringify 输出单行,天然安全)。 */
export function sseFrame(type, seq, data) {
  return `data: ${JSON.stringify({ type, seq, ts: Date.now(), data })}\n\n`;
}

/** 一个 SSE 输出端的信封封装:维护 seq、环形帧缓冲(供断线续接重放)。 */
export class SseStream {
  /**
   * @param {function(string):void} write - 原始写函数(写入 res;需已设置 text/event-stream 头)
   * @param {object} options - { bufferSize: 保留最近 N 帧供续接(默认 500) }
   */
  constructor(write, options = {}) {
    this.write = write;
    this.seq = 0;
    this.bufferSize = options.bufferSize ?? 500;
    this.buffer = []; // [{seq, frame}] 升序
    this.closed = false;
  }

  /** 推一帧;写失败(客户端断线)返回 false 并标记 closed。 */
  push(type, data) {
    if (this.closed) return false;
    const seq = ++this.seq;
    const frame = sseFrame(type, seq, data);
    // 环形缓冲:超限丢最旧
    if (this.buffer.length >= this.bufferSize) this.buffer.shift();
    this.buffer.push({ seq, frame });
    try {
      this.write(frame);
      return true;
    } catch {
      this.closed = true;
      return false;
    }
  }

  /** 续接:重放 buffer 中 seq > lastSeq 的帧(已写过的)。返回续接的帧数。 */
  resume(lastSeq) {
    if (this.closed) return 0;
    let n = 0;
    for (const { seq, frame } of this.buffer) {
      if (seq > lastSeq) {
        try {
          this.write(frame);
          n += 1;
        } catch {
          this.closed = true;
          break;
        }
      }
    }
    return n;
  }

  /** 强制关闭(预留;一般由 res end 处理)。 */
  close() {
    this.closed = true;
  }
}

/** SSE 响应头。 */
export function sseHeaders() {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "access-control-allow-origin": "*"
  };
}