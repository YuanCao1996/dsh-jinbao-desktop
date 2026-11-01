// Bound what the coach injects into a model turn.
//
// Measured production failure (2026-11-01): a live turn sent 377,000 bytes / 22
// messages while the model declares a 32,768-token window, and the local proxy
// caps upstream max_tokens at 2,048. The upstream answered 200 but truncated to
// finish_reason=length, so the model emitted a single reasoning byte, never
// called coach_reply and the overlay stayed silent. Compaction cannot rescue a
// single oversized message, so the injection itself has to be bounded.
//
// Server-side facts (verified read-only on the production gateway):
//  - game-fast routes to opencode_go -> model deepseek-v4.1-flash.
//  - The gateway accepts max_tokens <= 4096 and the Go path clamps it to 2048.
//  - Quota is metered in BYTES: promptBytes + toolsBytes + max_tokens + 256.
//    So a 377 KB turn cost ~15x the quota of a 24 KB turn for the same answer.
//  - The gateway never returned 413 for our turns, so the truncation came from
//    the model's own window, not from the 512 KB transport limit.
//
// Trimming prefers structured reductions over blind truncation: drop bulky
// history first, keep the newest events, clip only pathological strings.

/** Budget for one serialized context block, in UTF-8 bytes.
 *  The declared window is 32,768 tokens and compaction triggers at 0.7 (22,933),
 *  which also has to hold the system prompt, 18 tool schemas and the reply.
 *  24 KB (~11k tokens) leaves that headroom and keeps quota spend low. */
export const MAX_CONTEXT_BYTES = 24_000;

/** Last-resort budget for a whole adapter-built prompt. */
export const MAX_PROMPT_BYTES = 32_000;

const bytes = value => Buffer.byteLength(value, 'utf8');

function clip(value, max) {
  if (typeof value !== 'string' || bytes(value) <= max) return value;
  let text = value;
  while (bytes(text) > max && text.length > 1) text = text.slice(0, Math.floor(text.length * 0.8));
  return text + '…[已截断]';
}

function clipDeep(value, maxString) {
  if (typeof value === 'string') return clip(value, maxString);
  if (Array.isArray(value)) return value.map(item => clipDeep(item, maxString));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = clipDeep(item, maxString);
    return out;
  }
  return value;
}

const TAIL_KEYS = ['events', 'equipmentUpdates', 'broadcasts', 'chat', 'timeline', 'recentEvents'];

/**
 * Serialize a context payload within a byte budget.
 * Reductions, in order: drop previous-match history, clip oversized strings,
 * keep only the newest tail of event-like arrays, then reduce that tail further.
 * Returns { text, trimmed, originalBytes, bytes }.
 */
export function boundJsonStringify(value, maxBytes = MAX_CONTEXT_BYTES) {
  const first = JSON.stringify(value ?? {});
  const originalBytes = bytes(first);
  if (originalBytes <= maxBytes) return { text: first, trimmed: false, originalBytes, bytes: originalBytes };

  let working = value && typeof value === 'object' ? structuredClone(value) : value;

  // 1. Cross-match history is never needed for a live turn that names the match.
  for (const key of ['previousMatches', 'history', 'matchHistory']) {
    if (working && typeof working === 'object' && Array.isArray(working[key])) working[key] = [];
  }

  // 2. Pathological strings (raw logs pasted into a field) dominate the payload.
  working = clipDeep(working, 2000);

  let text = JSON.stringify(working);
  let tail = 40;
  while (bytes(text) > maxBytes && tail >= 2) {
    for (const key of TAIL_KEYS) {
      if (Array.isArray(working?.[key]) && working[key].length > tail) working[key] = working[key].slice(-tail);
    }
    text = JSON.stringify(working);
    tail = Math.floor(tail / 2);
  }

  if (bytes(text) > maxBytes) text = clip(text, maxBytes);
  return { text, trimmed: true, originalBytes, bytes: bytes(text) };
}

/** Last-resort guard for prompts assembled by an adapter. */
export function boundPrompt(text, maxBytes = MAX_PROMPT_BYTES) {
  const size = bytes(text);
  if (size <= maxBytes) return { text, trimmed: false, originalBytes: size, bytes: size };
  const bounded = clip(text, maxBytes);
  return { text: bounded, trimmed: true, originalBytes: size, bytes: bytes(bounded) };
}
