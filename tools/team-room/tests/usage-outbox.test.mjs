import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostUsageOutbox } from '../usage-outbox.mjs';
import { usageReportHash, usageReportId } from '../usage-report-format.mjs';
import { createRoomHostClient } from '../host-client.mjs';
import { createCredentials } from '../../cloud-desktop/credentials.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const origin = 'https://usage-reports.example';
const task = () => ({ id: randomUUID(), roomId: 'room-one', reserved: 50000, executionMode: 'byok' });
const tokenFor = task => 'jhu1.' + Buffer.from(JSON.stringify({ v: 1, purpose: 'host-usage', issuerHash: hash('fixture'), roomId: task.roomId,
  jobId: task.id, budgetId: 'budget-one', bindingId: 'binding-one', leaseId: 'lease-one', reserved: task.reserved })).toString('base64url') + '.' + 'a'.repeat(64);
const ackFor = ({ token, report }, disposition = 'settled') => ({ state: 'usage_report_received', reportHash: usageReportHash(report),
  reportId: usageReportId(token, report), ackId: hash(token), receivedAt: 2000, disposition });
function credentials() {
  const values = new Map(); let failWrites = false;
  return { values, fail: value => { failWrites = value; },
    async resolve(key) { assert.match(key, /^JINBAO_USAGE_(INDEX|RECORD)_[a-f0-9]{64}$/); return values.has(key) ? { value: values.get(key) } : undefined; },
    async set(key, value) { if (failWrites) throw Error('fixture-storage-unavailable'); values.set(key, value); },
    async unset(key) { values.delete(key); } };
}
async function fixture(t, extra = {}) {
  const store = extra.credentials ?? credentials(), requests = []; let clock = 1000, outbox;
  const open = async () => {
    outbox = await createHostUsageOutbox({ credentials: store, serviceBaseUrl: origin, now: () => clock,
      fetchImpl: extra.fetchImpl ?? (async (url, init) => { requests.push({ url: String(url), ...init }); return Response.json(ackFor(JSON.parse(init.body))); }) });
    await outbox.flush(); return outbox;
  };
  t.after(() => outbox?.close()); return { store, requests, open, advance: value => { clock += value; } };
}

test('native cost outbox seals only numerical evidence, uses no login and never sends an active task', async t => {
  const c = await fixture(t), outbox = await c.open(), job = task(), token = tokenFor(job);
  await outbox.begin(job, token); await outbox.checkpoint(job.id, { seq: 1, usage: 10000, known: false });
  await outbox.flush(); assert.equal(c.requests.length, 0);
  await outbox.checkpoint(job.id, { seq: 2, usage: 37, known: true }); await outbox.finalize(job.id); await outbox.flush();
  assert.equal(c.requests.length, 1); const request = c.requests[0]; assert.equal(request.url, origin + '/desktop/team-retention/host-usage');
  assert.deepEqual(request.headers, { 'Content-Type': 'application/json' }); assert.equal(request.redirect, 'error');
  assert.deepEqual(JSON.parse(request.body), { token, report: { seq: 2, usage: 37, known: true, finalized: true } });
  assert.doesNotMatch(request.body, /apiKey|Authorization|deviceSecret|text|messages|provider|principal/);
  assert.equal(outbox.status().pending, 0); assert.equal(outbox.status().received, 1);
  await assert.rejects(outbox.checkpoint(job.id, { seq: 3, usage: 40, known: true }), /stopped/);
  await assert.rejects(outbox.begin(job, token), /already_recorded/);
});

test('restart seals an interrupted known or unknown task without an Agent, model key or execution device proof', async t => {
  const c = await fixture(t); let outbox = await c.open(); const known = task(), unknown = task();
  await outbox.begin(known, tokenFor(known)); await outbox.checkpoint(known.id, { seq: 1, usage: 12, known: true });
  await outbox.begin(unknown, tokenFor(unknown)); await outbox.checkpoint(unknown.id, { seq: 1, usage: 10000, known: false });
  await outbox.close(); outbox = await c.open(); assert.equal(c.requests.length, 2);
  const reports = c.requests.map(request => JSON.parse(request.body).report); assert.ok(reports.some(report => report.known && report.usage === 12));
  assert.ok(reports.some(report => !report.known && report.usage === 10000)); assert.equal(outbox.status().received, 2);
});

test('lost or mismatched acknowledgements retain the same sealed cost and apply bounded retries', async t => {
  let calls = 0; const bodies = [];
  const c = await fixture(t, { fetchImpl: async (_url, init) => {
    bodies.push(init.body); const input = JSON.parse(init.body); calls++;
    if (calls === 1) throw Error('lost-ack');
    if (calls === 2) return Response.json({ ...ackFor(input), reportId: hash('another-job') });
    return Response.json(ackFor(input, 'held'));
  } });
  const outbox = await c.open(), job = task(); await outbox.begin(job, tokenFor(job)); await outbox.checkpoint(job.id, { seq: 1, usage: 10000, known: false });
  await outbox.finalize(job.id); await outbox.flush(); await outbox.flush(); assert.equal(calls, 1); assert.equal(outbox.status().pending, 1);
  c.advance(60000); await outbox.flush(); assert.equal(outbox.status().received, 0); c.advance(60000); await outbox.flush();
  assert.equal(new Set(bodies).size, 1); assert.equal(outbox.status().pending, 0); assert.equal(outbox.status().held, 1);
});

test('a missing, corrupt, cross-task or full outbox fails before accepting new model work, without dropping unresolved evidence', async t => {
  const c = await fixture(t), outbox = await c.open(), job = task();
  await assert.rejects(outbox.begin({ ...job, roomId: 'other' }, tokenFor(job)), /scope_mismatch/);
  await outbox.begin(job, tokenFor(job));
  await assert.rejects(outbox.checkpoint(job.id, { seq: 2, usage: 5, known: true }), /conflict/);
  await outbox.checkpoint(job.id, { seq: 1, usage: 12, known: true });
  await assert.rejects(outbox.checkpoint(job.id, { seq: 2, usage: 11, known: true }), /conflict/);
  for (let i = 1; i < 128; i++) { const next = task(); await outbox.begin(next, tokenFor(next)); }
  const next = task(); await assert.rejects(outbox.begin(next, tokenFor(next)), /capacity/); assert.equal(outbox.status().pending, 128);
  c.store.fail(true); await assert.rejects(outbox.finalize(job.id)); assert.equal(outbox.status().received, 0); c.store.fail(false);
  await outbox.close(); const recordKey = [...c.store.values.keys()].find(key => key.startsWith('JINBAO_USAGE_RECORD_')); c.store.values.delete(recordKey);
  await assert.rejects(c.open(), /usage_outbox_invalid/);
});

test('slow report upload does not block write-ahead checkpoints and close aborts only transport', async t => {
  let started; const began = new Promise(resolve => { started = resolve; });
  const c = await fixture(t, { fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
    started(); init.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true });
  }) });
  const outbox = await c.open(), first = task(); await outbox.begin(first, tokenFor(first)); await outbox.finalize(first.id);
  const uploading = outbox.flush(); await began; const next = task(); await outbox.begin(next, tokenFor(next));
  await outbox.checkpoint(next.id, { seq: 1, usage: 10000, known: false }); assert.equal(outbox.status().pending, 2);
  await outbox.close(); await uploading; assert.equal(outbox.status().state, 'stopped');
});

test('host transport persists known cost before a failing server acknowledgement and seals it for independent upload', async t => {
  const c = await fixture(t), outbox = await c.open(), job = { ...task(), sessionId: 'session', membershipVersion: 1, memoryVersion: 1 };
  const token = tokenFor(job); let native = 0, calls = 0;
  const client = { async acquireHost() { return { leaseId: 'lease', leaseUntil: Date.now() + 15000 }; },
    async pollHost() { return { job: { task: job, usageReportToken: token, definitions: [], turn: {} } }; },
    async checkHost() {}, async recordHostUsage(_room, _proof, request) { if (++calls === 2) throw Error('revoked-after-provider-response'); }, async failHost() {} };
  const host = createRoomHostClient({ client, roomId: job.roomId, credentials: {}, usageOutbox: outbox, pollMs: 100000, heartbeatMs: 100000,
    runNativeJob: async ({ reportUsage }) => { await reportUsage(10000, { known: false }); native++; await reportUsage(37); return { text: 'must-not-publish', usage: 37 }; } });
  t.after(() => host.stop()); await host.start(); await host.idle(); await outbox.flush();
  assert.equal(native, 1); assert.equal(c.requests.length, 1); assert.equal(JSON.parse(c.requests[0].body).report.usage, 37);
  assert.equal(JSON.parse(c.requests[0].body).report.known, true);
});

test('host persistence failure or a missing cost capability blocks the native runner', async t => {
  const c = await fixture(t), outbox = await c.open(); let native = 0;
  const job = { ...task(), sessionId: 'session', membershipVersion: 1, memoryVersion: 1 };
  const client = { async acquireHost() { return { leaseId: 'lease', leaseUntil: Date.now() + 15000 }; },
    async pollHost() { return { job: { task: job, definitions: [], turn: {} } }; }, async failHost() {} };
  const host = createRoomHostClient({ client, roomId: job.roomId, credentials: {}, usageOutbox: outbox,
    pollMs: 100000, heartbeatMs: 100000, runNativeJob: async () => { native++; } });
  t.after(() => host.stop()); await host.start(); await host.idle(); assert.equal(native, 0);
  await host.stop(); c.store.fail(true);
  const another = { ...job, id: randomUUID() };
  client.pollHost = async () => ({ job: { task: another, usageReportToken: tokenFor(another), definitions: [], turn: {} } });
  const blocked = createRoomHostClient({ client, roomId: another.roomId, credentials: {}, usageOutbox: outbox,
    pollMs: 100000, heartbeatMs: 100000, runNativeJob: async () => { native++; } });
  t.after(() => blocked.stop()); await blocked.start(); await blocked.idle(); assert.equal(native, 0); c.store.fail(false);
});

test('real Windows encrypted usage survives restart while the disposable group cache is absent', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'team-usage-dpapi-')); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const store = await createCredentials(root), c = await fixture(t, { credentials: store }); let outbox = await c.open();
  const job = task(); await outbox.begin(job, tokenFor(job)); await outbox.checkpoint(job.id, { seq: 1, usage: 37, known: true }); await outbox.close();
  assert.doesNotMatch(await readFile(join(root, 'credentials.dpapi'), 'utf8'), /jhu1|host-usage|room-one/);
  const reopened = await createCredentials(root); outbox = await createHostUsageOutbox({ credentials: reopened, serviceBaseUrl: origin,
    fetchImpl: async (_url, init) => Response.json(ackFor(JSON.parse(init.body))) });
  try { await outbox.flush(); assert.equal(outbox.status().received, 1); } finally { await outbox.close(); }
});
