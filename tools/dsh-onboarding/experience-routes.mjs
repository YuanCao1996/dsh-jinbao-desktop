// Pure routing/payload helpers for the experience API.
//
// The HTTP round-trip proof kept getting blocked by the environment (fixed port owned by the
// running app, service token, closing the server without hanging the suite). The part that was
// actually untested is the boring one: does a request with this method and path reach the right
// handler, and is the shape sent back correct? That needs no socket at all, so it lives here.

const PATH_LIST = '/api/experience';
const PATH_CORRECT = '/api/experience/correct';

export function experienceRoute(method, url) {
  const path = String(url ?? '').split('?')[0];
  const verb = String(method ?? '').toUpperCase();
  if (path === PATH_LIST) return verb === 'GET' ? { action: 'list' } : { action: 'method-not-allowed' };
  if (path === PATH_CORRECT) return verb === 'POST' ? { action: 'correct' } : { action: 'method-not-allowed' };
  return { action: 'none' };
}

// The settings page renders exactly these fields; status falls back for records written before the
// field existed, and private is coerced to a boolean so the page can style the row without guessing.
export function experienceListPayload(rows = []) {
  return {
    rows: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      claim: row.claim,
      scope: row.scope ?? [],
      private: Boolean(row.private),
      status: row.status ?? 'candidate',
      evidence: row.evidence ?? { games: 0, hits: 0, counter: 0 },
    })),
  };
}

// A veto without an id is a client bug: report it instead of pretending a lesson was demoted.
export function correctRequest(value) {
  const id = typeof value?.id === 'string' ? value.id.trim() : '';
  if (!id) return { ok: false, reason: 'missing-id' };
  return { ok: true, id, reason: String(value?.reason ?? '').slice(0, 200) };
}

// 公有经验库（社区共享）：同一套纯函数思路，先能单测再做 HTTP。
const PATH_PUBLIC = '/api/public/experience';

export function publicLibraryRoute(method, url) {
  const path = String(url ?? '').split('?')[0];
  const verb = String(method ?? '').toUpperCase();
  if (path !== PATH_PUBLIC) return { action: 'none' };
  if (verb === 'GET') return { action: 'query' };
  if (verb === 'POST') return { action: 'upsert' };
  return { action: 'method-not-allowed' };
}

// 查询参数一律夹紧：limit 最多 100 条，避免一次把整库拖走；minGames 不能是负数。
export function publicQueryParams(url) {
  let params;
  try { params = new URL(String(url ?? ''), 'http://127.0.0.1').searchParams; } catch { params = new URLSearchParams(); }
  const number = (name, fallback, low, high) => {
    const text = params.get(name);
    // Missing is not zero: Number(null) would silently turn "no filter" into "minGames=0".
    if (text === null || text.trim() === '') return fallback;
    const value = Number(text);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(high, Math.max(low, Math.trunc(value)));
  };
  return {
    game: params.get('game') || 'lol',
    patch: params.get('patch') || null,
    kind: params.get('kind') || null,
    limit: number('limit', 50, 1, 100),
    minGames: number('minGames', 1, 0, 10000),
  };
}

// 上传批次也夹紧：一次最多 100 条，防止误把整库推上来。
export function publicUpsertBody(value) {
  const lessons = Array.isArray(value?.lessons) ? value.lessons.slice(0, 100) : [];
  return { lessons };
}

// 私有经验 md 的读写（编辑后立刻生效）。
const PATH_MD = '/api/experience/md';
const KINDS = new Set(['recognition','knowledge','retrieval-web','retrieval-local','strategy','build','dispute','tool-failure','preference','correction','stats','pitfall','style']);

export function mdEditRoute(method, url) {
  const path = String(url ?? '').split('?')[0];
  if (path !== PATH_MD) return { action: 'none' };
  const verb = String(method ?? '').toUpperCase();
  if (verb === 'GET') return { action: 'read' };
  if (verb === 'POST') return { action: 'write' };
  return { action: 'method-not-allowed' };
}

// 只允许编辑私有类别；公有经验不能从本机改（要走服务端纠正流程）。
const PRIVATE_ONLY = new Set(['preference','correction','stats','pitfall','style']);
export function mdEditBody(value) {
  const kind = String(value?.kind ?? '').trim();
  if (!KINDS.has(kind)) return { ok: false, reason: 'unknown-kind' };
  if (!PRIVATE_ONLY.has(kind)) return { ok: false, reason: 'private-only' };
  const mdText = typeof value?.mdText === 'string' ? value.mdText.slice(0, 8000) : '';
  if (!mdText.trim()) return { ok: false, reason: 'empty' };
  const by = value?.by === 'agent' ? 'agent' : 'player';
  return { ok: true, kind, mdText, by, reason: String(value?.reason ?? '').slice(0, 160) };
}
