// One shared window for the event stream, so the overlay, the standalone cloud Agent
// and the in-host coach all describe the same events.
//
// Before this existed each consumer truncated differently (20 rows / 12 rows / 8 rows,
// some with 240-char text and some with full text) and the truncated copies dropped the
// event `kind`, which meant the Agent could see "01:05 购买装备：残疫" but not know it was
// an equipment event. That forced extra query round-trips before it could react.

/**
 * Rows kept per request, characters of text per row, and the serialized byte ceiling.
 * The byte ceiling is sized so 20 rows of full-length CJK text (~740 B each) still fit:
 * dropping below this would silently hand the Agent fewer events than the count promises.
 */
export const EVENT_WINDOW = Object.freeze({ count: 20, textChars: 240, totalBytes: 16000 });

const clip = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Project one stored event into the shape both lines hand to the model. */
export function projectEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const text = clip(event.text, EVENT_WINDOW.textChars);
  if (!text) return null;
  const row = { time: typeof event.time === 'string' ? event.time.slice(0, 12) : '', text };
  const kind = clip(event.kind, 40);
  // `kind` is what lets the Agent decide whether an event matters without querying.
  if (kind) row.kind = kind;
  return row;
}

/**
 * Newest-first retention with a byte budget: keep the most recent `count` events, then
 * drop the oldest until the serialized window fits `totalBytes`. `heldBack` reports how
 * many stored events did not fit, so the UI can say so instead of silently hiding them.
 */
export function eventWindow(events, { count = EVENT_WINDOW.count, totalBytes = EVENT_WINDOW.totalBytes } = {}) {
  const list = Array.isArray(events) ? events : [];
  const rows = [];
  for (const event of list.slice(-Math.max(0, count))) {
    const row = projectEvent(event);
    if (row) rows.push(row);
  }
  while (rows.length && Buffer.byteLength(JSON.stringify(rows)) > totalBytes) rows.shift();
  // Everything stored but not handed over: rows outside the count window, rows dropped
  // by the byte budget, and unprojectable rows.
  return { rows, heldBack: Math.max(0, list.length - rows.length) };
}
