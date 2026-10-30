import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRoomCacheStore } from '../cache-store.mjs';
import { createCacheReportUploader } from '../cache-reports.mjs';
import { cacheReceiptHash } from '../cache-report-format.mjs';
import { createCredentials } from '../../cloud-desktop/credentials.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const origin = 'https://cache-reports.example', originHash = hash(origin);
const tokenFor = (room, grant = 'fixture') => 'jhc1.' + Buffer.from(JSON.stringify({ v: 1, purpose: 'cache-report',
  issuerHash: hash('issuer'), scopeHash: hash(room), grantHash: hash(grant) })).toString('base64url') + '.' + 'a'.repeat(64);
const ackFor = receipt => ({ state: 'device_report_received', receiptId: receipt.id, receiptHash: cacheReceiptHash(receipt), ackId: hash(receipt.id), receivedAt: 2000 });
function memoryCredentials() {
  const values = new Map(); let writes = 0;
  return { values, writes: () => writes,
    async resolve(key) { assert.match(key, /^JINBAO_CACHE_REPORT_(INDEX|TOKEN)_[a-f0-9]{64}$/); return values.has(key) ? { value: values.get(key) } : undefined; },
    async set(key, value) { writes++; values.set(key, value); }, async unset(key) { values.delete(key); } };
}
async function fixture(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'team-cache-report-')); let at = 1000, uploader;
  const store = await createRoomCacheStore({ stateDir: root, now: () => at });
  const credentials = extra.credentials ?? memoryCredentials(), requests = [];
  const fetchImpl = extra.fetchImpl ?? (async (url, init) => { requests.push({ url: String(url), ...init }); return Response.json(ackFor(JSON.parse(init.body).receipt)); });
  const open = async () => {
    uploader = await createCacheReportUploader({ credentials, cacheStore: store, serviceBaseUrl: origin, now: () => at, fetchImpl });
    await uploader.flush(); return uploader;
  };
  t.after(async () => { await uploader?.close(); await store.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const remove = async (room = 'room-one') => {
    await store.authorize(room); const directory = join(root, 'team-host-sessions', hash(room));
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'history.jsonl'), 'PRIVATE-CHAT-MUST-NOT-UPLOAD');
    await store.removeRoom(room, 'local_withdraw'); return (await store.pendingReports(originHash)).find(receipt => receipt.scopeHash === hash(room));
  };
  return { root, store, credentials, requests, open, remove, advance: value => { at += value; } };
}

test('deletion outbox needs no login/model key and uploads only the minimal receipt after local deletion', async t => {
  const c = await fixture(t), uploader = await c.open(); await uploader.register('room-one', tokenFor('room-one'));
  const receipt = await c.remove(); await uploader.flush();
  assert.equal(c.requests.length, 1); const request = c.requests[0];
  assert.equal(request.url, origin + '/desktop/team-retention/cache-report'); assert.equal(request.redirect, 'error');
  assert.deepEqual(request.headers, { 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(request.body), { token: tokenFor('room-one'), receipt });
  assert.doesNotMatch(request.body, /PRIVATE-CHAT|room-one|apiKey|Authorization|deviceSecret|usage/);
  assert.equal(c.store.status().reportReceived, 1); assert.equal(c.store.status().reportPending, 0);
  assert.deepEqual(await c.store.pendingReports(originHash), []);
  const writes = c.credentials.writes(); await uploader.register('room-one', tokenFor('room-one'));
  assert.equal(c.credentials.writes(), writes, 'heartbeat does not rewrite the same encrypted token');
  await uploader.flush(); assert.equal(c.requests.length, 1);
});

test('a lost acknowledgement retries the same receipt after restart with a separately saved report-only token', async t => {
  let requests = 0; const sent = [];
  const c = await fixture(t, { fetchImpl: async (_url, init) => {
    const { receipt } = JSON.parse(init.body); sent.push(receipt); if (++requests === 1) throw new Error('lost-ack-private-detail');
    return Response.json(ackFor(receipt));
  } });
  let uploader = await c.open(); await uploader.register('room-one', tokenFor('room-one')); await c.remove(); await uploader.flush();
  assert.equal(c.store.status().reportPending, 1); assert.equal(uploader.status().state, 'pending');
  await uploader.flush(); assert.equal(requests, 1, 'no busy retries'); await uploader.close();
  // No room client, account, execution device proof or agent exists in the restarted process.
  uploader = await c.open(); assert.equal(requests, 2); assert.deepEqual(sent[0], sent[1]);
  assert.equal(c.store.status().reportReceived, 1); assert.equal(uploader.status().state, 'idle');
});

test('cross-room tokens and mismatched acknowledgements cannot mark a local deletion as server received', async t => {
  const c = await fixture(t, { fetchImpl: async (_url, init) => Response.json({ ...ackFor(JSON.parse(init.body).receipt), receiptHash: hash('wrong') }) });
  const uploader = await c.open(); await assert.rejects(uploader.register('room-one', tokenFor('another')), /scope_mismatch/);
  await uploader.register('room-one', tokenFor('room-one')); const receipt = await c.remove(); await uploader.flush();
  assert.equal(c.store.status().reportPending, 1); assert.equal(c.store.status().reportReceived, 0);
  await assert.rejects(c.store.acknowledgeReport(receipt.id, { ...ackFor(receipt), state: 'physical_deletion_verified' }, originHash), /report_mismatch/);
});

test('unbound historical receipts stay local until authority is available, then flush at most five per interval', async t => {
  const c = await fixture(t); for (let i = 0; i < 7; i++) await c.remove('room-' + i);
  const uploader = await c.open(); assert.equal(uploader.status().state, 'unbound'); assert.equal(c.requests.length, 0);
  for (let i = 0; i < 7; i++) await uploader.register('room-' + i, tokenFor('room-' + i));
  await uploader.flush(); assert.equal(c.requests.length, 5); assert.equal(c.store.status().reportPending, 2);
  await uploader.flush(); assert.equal(c.requests.length, 5); c.advance(60000); await uploader.flush();
  assert.equal(c.requests.length, 7); assert.equal(c.store.status().reportReceived, 7);
});

test('slow report delivery does not block host token persistence and shutdown aborts the report', async t => {
  let started; const began = new Promise(resolve => { started = resolve; });
  const c = await fixture(t, { fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
    started(); init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) });
  const uploader = await c.open(); await uploader.register('room-one', tokenFor('room-one')); await c.remove();
  const flush = uploader.flush(); await began;
  await uploader.register('room-two', tokenFor('room-two')); assert.equal(uploader.status().boundScopes, 2);
  await uploader.close(); await flush; assert.equal(uploader.status().state, 'stopped');
  assert.equal(c.store.status().reportPending, 1); await assert.rejects(uploader.register('room-one', tokenFor('room-one')), /closed/);
});

test('durable acknowledgements survive a store restart and restored cache files do not undo them', async t => {
  const c = await fixture(t), uploader = await c.open(); await uploader.register('room-one', tokenFor('room-one'));
  await c.remove(); await uploader.flush(); const before = await c.store.receipts();
  const directory = join(c.root, 'team-host-sessions', hash('room-one')); await mkdir(directory); await writeFile(join(directory, 'old'), 'RESTORED');
  await c.store.runOnce(); assert.deepEqual(await c.store.receipts(), before);
  await uploader.close(); await c.store.close(); const reopened = await createRoomCacheStore({ stateDir: c.root, now: () => 1000 });
  try { assert.equal(reopened.status().reportReceived, 1); assert.deepEqual(await reopened.pendingReports(originHash), []); } finally { await reopened.close(); }
});

test('real Windows encrypted credentials preserve report-only authority without storing plaintext', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'team-report-dpapi-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const credentials = await createCredentials(root), c = await fixture(t, { credentials });
  let uploader = await c.open(); await uploader.register('room-one', tokenFor('room-one')); await uploader.close();
  const encrypted = await readFile(join(root, 'credentials.dpapi'), 'utf8'); assert.doesNotMatch(encrypted, /jhc1|cache-report|room-one/);
  await c.remove();
  const reopened = await createCredentials(root);
  uploader = await createCacheReportUploader({ credentials: reopened, cacheStore: c.store, serviceBaseUrl: origin,
    fetchImpl: async (_url, init) => Response.json(ackFor(JSON.parse(init.body).receipt)) });
  try { await uploader.flush(); assert.equal(c.store.status().reportReceived, 1); } finally { await uploader.close(); }
});
