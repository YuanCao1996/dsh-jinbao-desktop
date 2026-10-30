import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, realpath, readdir, mkdir, open, rename, unlink, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { cacheReceiptPayload, cacheReceiptHash } from './cache-report-format.mjs';

export const ROOM_CACHE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const AUDIT_AGE = 90 * 24 * 60 * 60 * 1000;
const digest = value => createHash('sha256').update(value).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const time = value => Number.isSafeInteger(value) && value >= 0;
const reasons = new Set(['expired', 'clock_changed', 'legacy_unindexed', 'authorization_ended', 'local_withdraw', 'access_ended', 'new_authorization', 'privacy_changed']);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
function validate(value) {
  if (!exact(value, ['schemaVersion', 'entries', 'receipts']) || value.schemaVersion !== 1 || !exact(value.entries, Object.keys(value.entries ?? {}))
    || Object.keys(value.entries).length > 2048) fail('room_cache_index_invalid');
  for (const [scope, entry] of Object.entries(value.entries)) {
    if (!hex(scope) || !exact(entry, ['generation', 'lastAuthorizedAt', 'expiresAt', 'state', 'reason', 'operationId', 'deletedAt'])
      || !Number.isSafeInteger(entry.generation) || entry.generation < 1 || !time(entry.lastAuthorizedAt) || !time(entry.expiresAt)
      || entry.expiresAt > entry.lastAuthorizedAt + ROOM_CACHE_MAX_AGE || !['active', 'purging', 'deleted'].includes(entry.state)
      || entry.reason !== undefined && !reasons.has(entry.reason)
      || entry.operationId !== undefined && (typeof entry.operationId !== 'string' || !/^[a-f0-9-]{36}$/.test(entry.operationId))
      || entry.deletedAt !== undefined && !time(entry.deletedAt)
      || entry.state !== 'active' && (!entry.operationId || !entry.reason)
      || entry.state === 'deleted' && entry.deletedAt === undefined) fail('room_cache_index_invalid');
  }
  if (value.receipts !== undefined) {
    if (!exact(value.receipts, Object.keys(value.receipts ?? {})) || Object.keys(value.receipts).length > 2048) fail('room_cache_index_invalid');
    for (const [id, receipt] of Object.entries(value.receipts)) if (!/^[a-f0-9-]{36}$/.test(id)
      || !exact(receipt, ['scopeHash', 'generation', 'deletedAt', 'reason', 'state', 'serverAck']) || !hex(receipt.scopeHash)
      || !Number.isSafeInteger(receipt.generation) || receipt.generation < 1 || !time(receipt.deletedAt)
      || !reasons.has(receipt.reason) || receipt.state !== 'local_deleted'
      || receipt.serverAck !== undefined && (!exact(receipt.serverAck, ['id', 'originHash', 'receiptHash', 'receivedAt'])
        || !hex(receipt.serverAck.id) || !hex(receipt.serverAck.originHash) || !hex(receipt.serverAck.receiptHash) || !time(receipt.serverAck.receivedAt))) fail('room_cache_index_invalid');
  }
  return value;
}

// Storage-only maintenance: no SDK, model, account, network, game capture or key.
// Unindexed old preview caches are disposable, not authoritative room history.
export async function createRoomCacheStore({ stateDir, now = Date.now, intervalMs = 60000, trace = () => {} }) {
  if (!isAbsolute(stateDir ?? '')) fail('room_cache_directory_required');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const directory = await realpath(stateDir), root = join(directory, 'team-host-sessions'), indexPath = join(directory, 'team-host-cache.json');
  let state = { schemaVersion: 1, entries: {}, receipts: {} }, queue = Promise.resolve(), closed = false, timer;
  const guards = new Set();
  const failures = new Map();
  async function stat(path) { try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
  const indexStat = await stat(indexPath);
  if (indexStat) {
    if (!indexStat.isFile() || indexStat.isSymbolicLink() || indexStat.size > 1024 * 1024) fail('room_cache_index_invalid');
    const file = await open(indexPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { state = validate(JSON.parse(await file.readFile('utf8'))); } finally { await file.close(); }
  }
  state.receipts ??= {};
  for (const [scopeHash, entry] of Object.entries(state.entries)) if (entry.state === 'deleted' && !state.receipts[entry.operationId]) {
    state.receipts[entry.operationId] = { scopeHash, generation: entry.generation, deletedAt: entry.deletedAt, reason: entry.reason, state: 'local_deleted' };
  }
  const notify = event => { try { trace({ event }); } catch {} };
  async function save(next) {
    validate(next);
    const encoded = JSON.stringify(next); if (Buffer.byteLength(encoded) > 1024 * 1024) fail('room_cache_capacity');
    const info = await stat(indexPath); if (info && (!info.isFile() || info.isSymbolicLink())) fail('room_cache_index_invalid');
    const temp = indexPath + '.' + randomUUID() + '.tmp';
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(encoded); await file.sync(); } finally { await file.close(); }
    try {
      await rename(temp, indexPath);
      if (process.platform !== 'win32') { const parent = await open(directory, 'r'); try { await parent.sync(); } finally { await parent.close(); } }
      state = next;
    } finally { try { await unlink(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  async function children() {
    const info = await stat(root); if (!info) return [];
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) fail('unsafe_room_cache_root');
    const entries = await readdir(root, { withFileTypes: true });
    if (entries.length > 2048) fail('room_cache_capacity');
    if (entries.some(entry => !hex(entry.name))) fail('unsafe_room_cache_target');
    return entries.map(entry => entry.name);
  }
  async function checkedTarget(scope) {
    await children();
    const target = join(root, scope), info = await stat(target); if (!info) return null;
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(target) !== target) fail('unsafe_room_cache_target');
    let count = 0;
    async function inspect(path) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (++count > 100000) fail('room_cache_capacity');
        if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) fail('unsafe_room_cache_target');
        if (entry.isDirectory()) await inspect(join(path, entry.name));
      }
    }
    await inspect(target);
    if ((await lstat(target)).isSymbolicLink() || await realpath(target) !== target) fail('unsafe_room_cache_target');
    return target;
  }
  async function safeRemove(scope) {
    const target = await checkedTarget(scope); if (!target) return;
    await rm(target, { recursive: true, force: true });
    if (process.platform !== 'win32') { const parent = await open(root, 'r'); try { await parent.sync(); } finally { await parent.close(); } }
  }
  async function purgeRaw(scope, reason) {
    if (!hex(scope) || !reasons.has(reason)) fail('invalid_room_cache_cleanup');
    const prior = state.entries[scope];
    if (prior?.state === 'deleted' && !await stat(join(root, scope))) return true;
    if (prior?.state !== 'purging') {
      const next = structuredClone(state), at = now();
      next.entries[scope] = { generation: prior?.generation ?? 1, lastAuthorizedAt: prior?.lastAuthorizedAt ?? at,
        expiresAt: prior?.expiresAt ?? at, state: 'purging', reason, operationId: prior?.state === 'deleted' ? prior.operationId : randomUUID(),
        ...(prior?.state === 'deleted' ? { deletedAt: prior.deletedAt } : {}) };
      await save(next); // Intent is durable before cache disposal or unlinking.
    }
    for (const guard of guards) if (await guard(scope) === false) { notify('team_cache_cleanup_pending'); return false; }
    await safeRemove(scope);
    const next = structuredClone(state);
    next.entries[scope] = { ...next.entries[scope], state: 'deleted', deletedAt: next.entries[scope].deletedAt ?? now() };
    const entry = next.entries[scope];
    next.receipts[entry.operationId] = { ...next.receipts[entry.operationId], scopeHash: scope, generation: entry.generation, deletedAt: entry.deletedAt, reason: entry.reason, state: 'local_deleted' };
    await save(next); notify('team_cache_content_deleted'); return true;
  }
  async function purge(scope, reason) {
    if (!hex(scope) || !reasons.has(reason)) fail('invalid_room_cache_cleanup');
    try {
      const done = await purgeRaw(scope, reason);
      if (done) failures.delete(scope); else failures.set(scope, reason);
      return done;
    } catch (error) { failures.set(scope, reason); notify('team_cache_cleanup_pending'); throw error; }
  }
  async function sweep() {
    let deleted = 0, pending = 0;
    const scopes = new Set([...Object.keys(state.entries), ...failures.keys(), ...await children()]);
    for (const scope of scopes) {
      const entry = state.entries[scope], at = now();
      let reason = failures.get(scope) ?? (!entry ? 'legacy_unindexed' : entry.state !== 'active' ? entry.reason
        : at < entry.lastAuthorizedAt ? 'clock_changed' : at >= entry.expiresAt ? 'expired' : null);
      if (!reason) continue;
      if (entry?.state === 'deleted' && !await stat(join(root, scope))) {
        if (at >= entry.deletedAt + AUDIT_AGE) { const next = structuredClone(state); delete next.entries[scope]; await save(next); }
        continue;
      }
      try { if (await purge(scope, reason)) deleted++; else pending++; }
      catch { pending++; notify('team_cache_cleanup_pending'); }
    }
    if (Object.values(state.receipts).some(receipt => now() >= receipt.deletedAt + AUDIT_AGE)) {
      const next = structuredClone(state);
      for (const [id, receipt] of Object.entries(next.receipts)) if (now() >= receipt.deletedAt + AUDIT_AGE) delete next.receipts[id];
      await save(next);
    }
    return { deleted, pending };
  }
  function serial(fn) {
    const job = queue.then(() => { if (closed) fail('room_cache_closed'); return fn(); }); queue = job.catch(() => {}); return job;
  }
  function scopeFor(roomId) {
    if (typeof roomId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(roomId)) fail('invalid_room_cache_cleanup');
    return digest(roomId);
  }
  await sweep();
  timer = setInterval(() => { void serial(sweep).catch(() => notify('team_cache_cleanup_pending')); }, intervalMs); timer.unref();
  return {
    runOnce: () => serial(sweep),
    authorize: roomId => serial(async () => {
      const scope = scopeFor(roomId); let entry = state.entries[scope];
      if (failures.has(scope)) { if (!await purge(scope, failures.get(scope))) fail('room_cache_cleanup_pending'); entry = state.entries[scope]; }
      if ((!entry || entry.state === 'deleted') && await stat(join(root, scope))) {
        if (!await purge(scope, entry?.reason ?? 'legacy_unindexed')) fail('room_cache_cleanup_pending');
        entry = state.entries[scope];
      }
      if (entry && (entry.state === 'purging' || entry.state === 'active' && (now() < entry.lastAuthorizedAt || now() >= entry.expiresAt))) {
        if (!await purge(scope, entry.reason ?? (now() < entry.lastAuthorizedAt ? 'clock_changed' : 'expired'))) fail('room_cache_cleanup_pending');
        entry = state.entries[scope];
      }
      await checkedTarget(scope);
      const at = now(), generation = (entry?.generation ?? 0) + (entry?.state === 'active' ? 0 : 1), next = structuredClone(state);
      next.entries[scope] = { generation, lastAuthorizedAt: at, expiresAt: at + ROOM_CACHE_MAX_AGE, state: 'active' };
      await save(next); return { scopeHash: scope, generation };
    }),
    assertActive: lease => serial(() => {
      const entry = state.entries[lease?.scopeHash];
      if (!entry || entry.state !== 'active' || entry.generation !== lease.generation || now() < entry.lastAuthorizedAt || now() >= entry.expiresAt) fail('room_cache_lease_ended');
    }),
    removeRoom: (roomId, reason) => serial(() => purge(scopeFor(roomId), reason)),
    clearBeforeGrant: roomId => serial(async () => {
      const scope = scopeFor(roomId), entry = state.entries[scope], exists = await stat(join(root, scope));
      if (!exists && (!entry || entry.state === 'deleted') && !failures.has(scope)) return true;
      return purge(scope, 'new_authorization');
    }),
    attach: guard => { if (closed || typeof guard !== 'function') fail('invalid_room_cache_guard'); guards.add(guard); return () => guards.delete(guard); },
    receipts: () => serial(() => Object.entries(state.receipts).map(([id, receipt]) => ({ id, ...receipt }))),
    pendingReports: originHash => serial(() => Object.entries(state.receipts).filter(([, receipt]) => receipt.serverAck?.originHash !== originHash)
      .map(([id, { scopeHash, generation, deletedAt, reason, state }]) => cacheReceiptPayload({ id, scopeHash, generation, deletedAt, reason, state }))),
    reportScopes: originHash => serial(() => [...new Set([...Object.entries(state.entries).filter(([, entry]) => entry.state !== 'deleted').map(([scope]) => scope),
      ...Object.values(state.receipts).filter(receipt => receipt.serverAck?.originHash !== originHash).map(receipt => receipt.scopeHash)])]),
    acknowledgeReport: (id, ack, originHash) => serial(async () => {
      const receipt = state.receipts[id]; if (!receipt) return false;
      const { scopeHash, generation, deletedAt, reason, state: localState } = receipt;
      const expected = cacheReceiptHash({ id, scopeHash, generation, deletedAt, reason, state: localState });
      if (!hex(originHash) || ack?.state !== 'device_report_received' || ack.receiptId !== id || ack.receiptHash !== expected || !hex(ack.ackId) || !time(ack.receivedAt)) fail('room_cache_report_mismatch');
      const next = structuredClone(state);
      next.receipts[id].serverAck = { id: ack.ackId, originHash, receiptHash: expected, receivedAt: ack.receivedAt };
      await save(next); return true;
    }),
    status: () => {
      const pending = new Set(failures.keys()); let active = 0;
      for (const [scope, entry] of Object.entries(state.entries)) {
        if (entry.state === 'purging' || entry.state === 'active' && (now() < entry.lastAuthorizedAt || now() >= entry.expiresAt)) pending.add(scope);
        else if (entry.state === 'active' && !pending.has(scope)) active++;
      }
      const receipts = Object.values(state.receipts), reportReceived = receipts.filter(receipt => receipt.serverAck).length;
      return { supported: true, maxAgeDays: 30, active, pending: pending.size, localDeleted: receipts.length,
        reportReceived, reportPending: receipts.length - reportReceived };
    },
    async close() { closed = true; clearInterval(timer); await queue; guards.clear(); },
  };
}
