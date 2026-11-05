import { createPublicLibrary } from '../dsh-coach-server/lib/public-library.mjs';
import { publicLibraryRoute, publicQueryParams, publicUpsertBody } from './experience-routes.mjs';

// Gateway handler for the shared lesson library.
//
// The preview gateway dispatches requests through a chain of `(req, res) => boolean` handlers, so
// plugging in means returning false for everything that is not ours. That keeps the change to a
// single line in server/main.mjs and makes rollback trivial.
//
// Nothing player-shaped can be written here: every lesson goes through the same anonymisation gate
// the desktop client uses, and the store re-validates it again.

const DEFAULT_MAX_BODY = 64 * 1024;

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  } catch {}
  res.end(body);
}

async function readJson(req, maxBody) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBody) throw new Error('body-too-large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createPublicExperienceHandler({ dir, maxBody = DEFAULT_MAX_BODY, authorize = null } = {}) {
  if (!dir) throw new Error('public experience handler needs a data directory');
  const library = createPublicLibrary({ dir });

  return async function publicExperienceHandler(req, res) {
    const { action } = publicLibraryRoute(req?.method, req?.url);
    if (action === 'none') return false;
    if (action === 'method-not-allowed') {
      send(res, 405, { error: 'method-not-allowed' });
      return true;
    }
    // 读默认可匿名；写可以通过 authorize 钩子要求令牌（由调用方决定策略，这里不猜）。
    if (authorize && action === 'upsert') {
      let allowed = false;
      try { allowed = await authorize(req); } catch { allowed = false; }
      if (!allowed) { send(res, 401, { error: 'unauthorized' }); return true; }
    }
    try {
      if (action === 'query') {
        send(res, 200, { lessons: await library.query(publicQueryParams(req.url)) });
        return true;
      }
      const payload = publicUpsertBody(await readJson(req, maxBody));
      send(res, 200, await library.upsert(payload.lessons));
      return true;
    } catch (error) {
      // A malformed upload must not take the gateway down or leak internals.
      send(res, 400, { error: 'bad-request', reason: String(error?.message ?? 'invalid').slice(0, 60) });
      return true;
    }
  };
}
