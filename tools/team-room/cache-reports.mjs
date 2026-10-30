import { createHash } from 'node:crypto';
import { serviceUrl, limitedJson } from '../dsh-game-services/client.mjs';
import { cacheReceiptHash } from './cache-report-format.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const MAX_AGE = 90 * 86400000;
function scopeOf(token) {
  if (typeof token !== 'string' || token.length > 2048 || !/^jhc1\.[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(token)) fail('invalid_cache_report_token');
  let value; try { value = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch { fail('invalid_cache_report_token'); }
  if (value?.v !== 1 || value.purpose !== 'cache-report' || !hex(value.scopeHash) || !hex(value.grantHash) || !hex(value.issuerHash)) fail('invalid_cache_report_token');
  return value.scopeHash;
}

// Native-only outbox. It never obtains a login/model key, forwards redirects,
// uploads content, or treats a received report as proof of every disk copy.
export async function createCacheReportUploader({ credentials, cacheStore, serviceBaseUrl = 'https://api.jinbaoai.top', fetchImpl = fetch,
  now = Date.now, intervalMs = 60000, timeoutMs = 10000, trace = () => {} }) {
  const service = serviceUrl(serviceBaseUrl);
  if (service.pathname !== '/') fail('invalid_cache_report_service');
  const originHash = digest(service.origin), indexKey = 'JINBAO_CACHE_REPORT_INDEX_' + originHash;
  const tokenKey = scope => 'JINBAO_CACHE_REPORT_TOKEN_' + digest(originHash + ':' + scope);
  let scopes = [], queue = Promise.resolve(), closed = false, flushing = false, nextAttempt = 0, timer, currentAbort = null, flushJob = null;
  let state = 'idle';
  const index = await credentials.resolve(indexKey);
  if (index) {
    let value; try { value = JSON.parse(index.value); } catch { fail('cache_report_credentials_invalid'); }
    if (value?.version !== 1 || !Array.isArray(value.scopes) || value.scopes.length > 64 || value.scopes.some(scope => !hex(scope))
      || new Set(value.scopes).size !== value.scopes.length) fail('cache_report_credentials_invalid');
    scopes = value.scopes;
  }
  const notify = action => { try { trace({ event: action }); } catch {} };
  const serial = fn => { const job = queue.then(fn); queue = job.catch(() => {}); return job; };
  async function persistIndex(next) { await credentials.set(indexKey, JSON.stringify({ version: 1, scopes: next })); scopes = next; }
  async function savedToken(scope) {
    const stored = await credentials.resolve(tokenKey(scope)); if (!stored) return null;
    let record; try { record = JSON.parse(stored.value); } catch { return null; }
    if (record?.version !== 1 || !Number.isSafeInteger(record.lastSeenAt) || record.lastSeenAt < 0) return null;
    try { if (scopeOf(record.token) !== scope) return null; } catch { return null; }
    return record;
  }
  async function prune() {
    const needed = new Set(await cacheStore.reportScopes(originHash));
    for (const scope of [...scopes]) {
      const saved = await savedToken(scope);
      if (!needed.has(scope) && (!saved || now() >= saved.lastSeenAt + MAX_AGE)) {
        await credentials.unset(tokenKey(scope)); await persistIndex(scopes.filter(value => value !== scope));
      }
    }
  }
  async function flushNow() {
    if (closed || flushing || now() < nextAttempt) return;
    flushing = true;
    try {
      const receipts = (await cacheStore.pendingReports(originHash)).sort((a, b) => a.deletedAt - b.deletedAt);
      let attempted = 0, unbound = false;
      for (const receipt of receipts) {
        if (closed || attempted >= 5) break;
        if (!scopes.includes(receipt.scopeHash)) { unbound = true; continue; }
        const stored = await savedToken(receipt.scopeHash);
        if (!stored) { unbound = true; continue; }
        attempted++; state = 'sending'; currentAbort = new AbortController();
        const response = await fetchImpl(new URL('/desktop/team-retention/cache-report', service), {
          method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: stored.token, receipt }), signal: AbortSignal.any([currentAbort.signal, AbortSignal.timeout(timeoutMs)]) });
        if (!response.ok) { await response.body?.cancel(); state = response.status === 403 ? 'authorization_unavailable' : 'pending'; throw new Error('cache_report_pending'); }
        const ack = await limitedJson(response, 4096);
        if (ack?.receiptId !== receipt.id || ack?.receiptHash !== cacheReceiptHash(receipt)) fail('room_cache_report_mismatch');
        await cacheStore.acknowledgeReport(receipt.id, ack, originHash);
        notify('team_cache_report_received'); currentAbort = null;
      }
      state = closed ? 'stopped' : (await cacheStore.pendingReports(originHash)).length ? unbound && attempted === 0 ? 'unbound' : 'pending' : 'idle';
      if (state === 'pending' || state === 'unbound') nextAttempt = now() + intervalMs;
      if (!closed) await serial(prune);
    } catch {
      if (closed) state = 'stopped'; else { if (state !== 'authorization_unavailable') state = 'pending'; nextAttempt = now() + intervalMs; notify('team_cache_report_pending'); }
    } finally { currentAbort = null; flushing = false; }
  }
  function flush() {
    if (!flushJob) {
      const job = flushNow(); flushJob = job;
      void job.finally(() => { if (flushJob === job) flushJob = null; }).catch(() => {});
    }
    return flushJob;
  }
  timer = setInterval(() => { void flush().catch(() => {}); }, intervalMs); timer.unref();
  void flush().catch(() => {});
  return {
    status: () => ({ supported: true, state, boundScopes: scopes.length }),
    async register(roomId, token) {
      return serial(async () => {
        if (closed) fail('cache_report_uploader_closed');
        if (typeof roomId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(roomId) || scopeOf(token) !== digest(roomId)) fail('cache_report_scope_mismatch');
        const scope = digest(roomId), prior = await savedToken(scope);
        if (!scopes.includes(scope) && scopes.length >= 64) {
          const needed = new Set(await cacheStore.reportScopes(originHash)), removable = scopes.filter(value => !needed.has(value));
          if (!removable.length) fail('cache_report_capacity');
          await credentials.unset(tokenKey(removable[0])); await persistIndex(scopes.filter(value => value !== removable[0]));
        }
        if (prior?.token !== token || now() >= prior.lastSeenAt + 86400000) await credentials.set(tokenKey(scope), JSON.stringify({ version: 1, token, lastSeenAt: now() }));
        if (!scopes.includes(scope)) await persistIndex([...scopes, scope]);
        if (state === 'unbound') nextAttempt = 0;
      });
    },
    flush,
    async close() { closed = true; clearInterval(timer); currentAbort?.abort(); await queue; await flushJob; state = 'stopped'; },
  };
}
