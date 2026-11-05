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
