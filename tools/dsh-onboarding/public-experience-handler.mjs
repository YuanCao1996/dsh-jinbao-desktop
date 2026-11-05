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

export function createPublicExperienceHandler({ dir, maxBody = DEFAULT_MAX_BODY, authorize = null, allowRead = false, identify = null, allowPending = false, requireWriteAuth = true } = {}) {
  if (!dir) throw new Error('public experience handler needs a data directory');
  const library = createPublicLibrary({ dir });

  return async function publicExperienceHandler(req, res) {
    const { action } = publicLibraryRoute(req?.method, req?.url);
    if (action === 'none') return false;
    if (action === 'method-not-allowed') {
      send(res, 405, { error: 'method-not-allowed' });
      return true;
    }
    // 读默认被禁；写与编辑一律要求登录——匿名客户端没有任何写入理由。
    if (authorize && action === 'upsert') {
      let allowed = false;
      try { allowed = await authorize(req); } catch { allowed = false; }
      if (!allowed) { send(res, 401, { error: 'unauthorized' }); return true; }
    }
    // 经验原文默认不下发：服务端注入模式下，客户端没有任何理由需要它。
    // 只有显式 allowRead（本地调试/迁移期）并且通过 authorize 才允许读。
    if (action === 'query') {
      if (!allowRead) { send(res, 403, { error: 'read-disabled' }); return true; }
      let readAllowed = true;
      if (authorize) { try { readAllowed = await authorize(req); } catch { readAllowed = false; } }
      if (!readAllowed) { send(res, 401, { error: 'unauthorized' }); return true; }
    }
    if (action === 'upsert') {
      let allowed = false;
      if (requireWriteAuth) { try { allowed = authorize ? await authorize(req) : false; } catch { allowed = false; } }
      else { allowed = true; }
      if (!allowed) { send(res, 401, { error: 'unauthorized' }); return true; }
    }
    try {
      if (action === 'query') {
        send(res, 200, { lessons: await library.query({ ...publicQueryParams(req.url), includePending: allowPending }) });
        return true;
      }
      const payload = publicUpsertBody(await readJson(req, maxBody));
      // 账号只用于独立账号计数与每日配额，库内只保存哈希。
      let account = null;
      if (identify) { try { account = await identify(req); } catch { account = null; } }
      const result = await library.upsert(payload.lessons, { account });
      send(res, 200, result);return true;
      return true;
    } catch (error) {
      // A malformed upload must not take the gateway down or leak internals.
      send(res, 400, { error: 'bad-request', reason: String(error?.message ?? 'invalid').slice(0, 60) });
      return true;
    }
  };
}
