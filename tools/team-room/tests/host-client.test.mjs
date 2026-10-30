import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomHostClient } from '../host-client.mjs';

test('report-only authority must be durably saved before polling or running a native job', async t => {
  let release, polled = 0, ran = 0;
  const saved = new Promise(resolve => { release = resolve; });
  const f = fixture({ acquireHost: async () => ({ leaseId: 'lease-1', leaseUntil: Date.now() + 15000, cacheReportToken: 'report-only-fixture' }),
    pollHost: async () => { polled++; return { job: null }; } });
  const device = createRoomHostClient({ client: f.client, roomId: 'room-1', credentials: {}, pollMs: 100000, heartbeatMs: 100000,
    onCacheReportToken: async token => { assert.equal(token, 'report-only-fixture'); await saved; }, runNativeJob: async () => { ran++; } });
  t.after(() => device.stop()); const start = device.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(polled, 0); assert.equal(ran, 0); release(); await start; assert.equal(polled, 1);
});

test('failed token persistence and a late save after stop never allow host work', async t => {
  let polled = 0, release;
  const f = fixture({ pollHost: async () => { polled++; return { job: null }; } });
  const options = { client: f.client, roomId: 'room-1', credentials: {}, pollMs: 100000, heartbeatMs: 100000, runNativeJob: f.native };
  const failed = createRoomHostClient({ ...options, onCacheReportToken: async () => { throw new Error('storage failed'); } });
  t.after(() => failed.stop()); await failed.start(); assert.equal(polled, 0);
  const slow = createRoomHostClient({ ...options, onCacheReportToken: () => new Promise(resolve => { release = resolve; }) });
  t.after(() => slow.stop()); const start = slow.start(); await new Promise(resolve => setImmediate(resolve));
  await slow.stop(); release(); await start; assert.equal(polled, 0); assert.equal(f.calls(), 0);
});

function fixture(overrides = {}) {
  let calls = 0;
  const job = { task: { id: 'job-1', roomId: 'room-1', sessionId: 'session-1', membershipVersion: 1, memoryVersion: 1, reserved: 50000, executionMode: 'byok' },
    turn: { sender: { id: 'sender' }, current: { game: 'lol' } }, definitions: [{ name: 'get_current_match', parameters: { type: 'object', properties: {} } }] };
  const records = [], results = [], failed = [];
  const client = {
    async acquireHost() { return { leaseId: 'lease-1', leaseUntil: Date.now() + 15000 }; },
    async heartbeatHost() { return { leaseUntil: Date.now() + 15000 }; },
    async pollHost() { return { job: structuredClone(job) }; },
    async checkHost() { return { active: true }; },
    async recordHostUsage(_room, _proof, input) { records.push(input); return { recorded: true }; },
    async executeHostTool() { return { state: 'playing' }; },
    async completeHost(_room, _proof, input) { results.push(input); return { accepted: true }; },
    async failHost(_room, _proof, jobId) { failed.push(jobId); },
    ...overrides,
  };
  const native = async ({ task, tools, reportUsage, signal }) => {
    calls++; await tools.check(); await reportUsage(1000, { known: false }); signal.throwIfAborted();
    await tools.execute('get_current_match', {}, signal); await reportUsage(20); return { text: '一起等控制。', usage: 20 };
  };
  const create = (runNativeJob = native) => createRoomHostClient({ client, roomId: 'room-1',
    credentials: { deviceId: 'device', deviceSecret: 'local-device-secret' }, runNativeJob,
    pollMs: 100000, heartbeatMs: 100000 });
  return { create, client, job, native, records, results, failed, calls: () => calls };
}

test('repeated delivery and a lost final acknowledgement never run native DSH twice', async t => {
  let completed = 0;
  const fixtureValue = fixture({ async completeHost() { if (++completed === 1) throw new Error('lost response'); return { accepted: true }; } });
  const device = fixtureValue.create(); t.after(() => device.stop());
  await device.start(); await device.idle();
  await device.poll(); await device.idle();
  assert.equal(fixtureValue.calls(), 1); assert.equal(completed, 2);
  assert.deepEqual(fixtureValue.records.map(row => row.seq), [1, 2, 3]);
});

test('failed durable usage acknowledgement stops before the local provider and exposes no provider detail', async t => {
  let providerCalls = 0;
  const fixtureValue = fixture({ async recordHostUsage() { throw new Error('private diagnostic'); } });
  const states = [];
  const device = createRoomHostClient({ client: fixtureValue.client, roomId: 'room-1', credentials: {},
    onStatus: state => states.push(state), pollMs: 100000, heartbeatMs: 100000,
    runNativeJob: async ({ reportUsage }) => { await reportUsage(1000, { known: false }); providerCalls++; return { text: 'hello', usage: 10 }; } });
  t.after(() => device.stop());
  await device.start(); await device.idle();
  assert.equal(providerCalls, 0); assert.deepEqual(fixtureValue.failed, ['job-1']);
  assert.equal(JSON.stringify(states).includes('private'), false);
});

test('an ended device authorization is distinguished from transient offline state without invoking DSH', async t => {
  const f = fixture({ acquireHost: async () => { throw Object.assign(new Error('private-provider-details'), { code: 'host_authorization_required', status: 403 }); } });
  const states = [], device = createRoomHostClient({ client: f.client, roomId: 'room-1', credentials: {}, runNativeJob: f.native,
    onStatus: value => states.push(value.state), pollMs: 100000, heartbeatMs: 100000 });
  t.after(() => device.stop()); await device.start();
  assert.deepEqual(states, ['authorization_required']); assert.equal(f.calls(), 0);
});

test('remote job definitions cannot mount shell, screenshots, private memory or file tools', async t => {
  const fixtureValue = fixture(); fixtureValue.job.definitions.push({ name: 'read_file' });
  const device = fixtureValue.create(); t.after(() => device.stop());
  await device.start(); await device.idle();
  assert.equal(fixtureValue.calls(), 0); assert.deepEqual(fixtureValue.results, []);
});

test('heartbeat failure aborts the current DSH job and never retries its model request', async t => {
  const fixtureValue = fixture({ async heartbeatHost() { throw new Error('offline'); } });
  let called = 0;
  const device = fixtureValue.create(async ({ signal, reportUsage }) => {
    called++; await reportUsage(1000, { known: false });
    await new Promise((resolve, reject) => { if (signal.aborted) reject(new Error('aborted')); else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
  });
  t.after(() => device.stop());
  await device.start(); await device.heartbeat(); await device.idle();
  await device.heartbeat(); await device.poll(); await device.idle();
  assert.equal(called, 1); assert.deepEqual(fixtureValue.results, []);
});

test('a poll arriving after stop cannot start a new native DSH request', async () => {
  let deliver;
  const fixtureValue = fixture({ pollHost: () => new Promise(resolve => { deliver = resolve; }) });
  const device = fixtureValue.create();
  const starting = device.start();
  while (!deliver) await new Promise(resolve => setTimeout(resolve, 1));
  await device.stop(); deliver({ job: fixtureValue.job }); await starting;
  assert.equal(fixtureValue.calls(), 0);
});

test('a server-cancelled job aborts the local provider even while the device lease remains online', async t => {
  const fixtureValue = fixture(); let cancelled = false, checks = 0;
  fixtureValue.client.checkHost = async () => { if (++checks > 1) throw Object.assign(new Error('host_job_unavailable'), { status: 404 }); return { active: true }; };
  const device = fixtureValue.create(async ({ signal, reportUsage }) => {
    await reportUsage(1000, { known: false });
    await new Promise((resolve, reject) => {
      if (signal.aborted) { cancelled = true; reject(new Error('cancelled')); }
      else signal.addEventListener('abort', () => { cancelled = true; reject(new Error('cancelled')); }, { once: true });
    });
  });
  t.after(() => device.stop());
  await device.start(); await device.heartbeat(); await device.idle();
  assert.equal(cancelled, true); assert.deepEqual(fixtureValue.results, []);
});
