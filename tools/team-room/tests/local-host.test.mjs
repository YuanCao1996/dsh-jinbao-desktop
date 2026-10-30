import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalRoomHost } from '../local-host.mjs';
import { createCredentials } from '../../cloud-desktop/credentials.mjs';
import { createRoomCacheStore } from '../cache-store.mjs';

function fixture(extra = {}) {
  const values = new Map(), sent = [], devices = [], executions = [];
  let closed = 0, stopped = 0;
  const options = { stateDir: 'unused-fixture', getConfig: async () => ({}), getKey: async () => 'fixture-model-key',
    credentials: { async set(key, value) { values.set(key, value); }, async resolve(key) { return values.has(key) ? { value: values.get(key) } : undefined; }, async unset(key) { values.delete(key); } },
    client: { async proposeHost(roomId, input) { sent.push({ roomId, ...input }); return { proposalId: 'proposal-one', deviceSecret: 'S'.repeat(43), expiresAt: Date.now() + 300000 }; },
      async withdrawHost() { sent.push({ withdrawn: true }); } },
    runnerFactory: async () => ({ async run(input) { executions.push(input); return { text: '先等控制。', usage: 12 }; }, async close() { closed++; } }),
    deviceFactory: input => { devices.push(input); return { async start() { input.onStatus({ state: 'connected' }); }, async stop() { stopped++; input.onStatus({ state: 'stopped' }); } }; }, ...extra };
  const room = { id: 'room-one', selfMemberId: 'host', executionMode: 'byok' };
  const grant = { configured: true, memberId: 'host', executionAvailable: true, proposals: [] };
  return { options, values, sent, devices, executions, room, grant, counts: () => ({ closed, stopped }), create: () => createLocalRoomHost(options) };
}

test('local host requires explicit consent, waits for the actual approval and never returns device proofs', async t => {
  const c = fixture(), host = c.create(); t.after(() => host.close());
  await host.synchronize(c.room, c.grant); assert.equal(c.devices.length, 0);
  await assert.rejects(host.propose(c.room.id, { deviceName: '电脑', maxTokens: 50000, apiKey: 'forbidden' }), /invalid_host_proposal/);
  const view = await host.propose(c.room.id, { deviceName: '电脑', maxTokens: 50000 });
  assert.equal(view.state, 'waiting_approval');
  await host.synchronize(c.room, { ...c.grant, proposals: [{ id: 'proposal-one', expiresAt: Date.now() + 300000 }] });
  assert.equal(c.devices.length, 0, 'an existing grant for the same member does not approve a new device');
  await host.synchronize(c.room, c.grant); assert.equal(c.devices.length, 1);
  assert.equal(host.view().state, 'connected');
  assert.doesNotMatch(JSON.stringify([view, host.view(), c.sent]), /SSSSSS|fixture-model-key|deviceSecret/);
  await assert.rejects(host.propose(c.room.id, { deviceName: '另一台', maxTokens: 50000 }), /already_enabled/);
});

test('official mode keeps an idle approved lease for route selection; leaving and reconfiguration drain native resources', async t => {
  const c = fixture(), host = c.create(); t.after(() => host.close());
  await host.propose(c.room.id, { deviceName: '电脑', maxTokens: 50000 });
  await host.synchronize(c.room, c.grant);
  await host.synchronize({ ...c.room, executionMode: 'official' }, c.grant);
  assert.equal(host.view().state, 'route_required'); assert.equal(c.counts().stopped, 0);
  assert.equal(c.devices.length, 1);
  await host.synchronize(c.room, c.grant); await host.reconfigure(); assert.equal(c.counts().stopped, 1);
  await host.synchronize(c.room, c.grant); await host.synchronize(null); assert.equal(c.counts().stopped, 2);
  await host.synchronize(c.room, c.grant); await host.withdraw(c.room.id);
  assert.equal(host.view().enabled, false); assert.equal(c.values.size, 0); assert.deepEqual(c.executions, []);
});

test('revoked or expired authorization removes saved device proof and never silently proposes again', async t => {
  const c = fixture(), host = c.create(); t.after(() => host.close());
  await host.propose(c.room.id, { deviceName: '电脑', maxTokens: 50000 }); await host.synchronize(c.room, c.grant);
  await host.synchronize(c.room, { configured: false, proposals: [] });
  assert.equal(host.view().state, 'authorization_required'); assert.equal(c.values.size, 0);
  await host.synchronize(c.room, c.grant); assert.equal(c.devices.length, 1); assert.equal(c.sent.length, 1);
});

test('unwritable encrypted credentials stop before connecting; failed withdrawal disables future native work', async t => {
  const broken = fixture({ credentials: { async resolve() {}, async set() { throw new Error('fixture-protection-failure'); } } });
  const host = broken.create(); t.after(() => host.close());
  await assert.rejects(host.propose('room-one', { deviceName: '电脑', maxTokens: 50000 }));
  assert.equal(broken.devices.length, 0); assert.equal(broken.counts().closed, 1);
  const c = fixture(), live = c.create(); t.after(() => live.close());
  await live.propose(c.room.id, { deviceName: '电脑', maxTokens: 50000 }); await live.synchronize(c.room, c.grant);
  c.options.client.withdrawHost = async () => { throw new Error('offline'); };
  await assert.rejects(live.withdraw(c.room.id));
  await live.synchronize(c.room, c.grant); assert.equal(c.devices.length, 1); assert.equal(live.view().enabled, false);
});

test('real Windows CurrentUser DPAPI persists device consent across restart without plaintext credentials', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'team-host-dpapi-'));
  t.after(() => rm(stateDir, { recursive: true, force: true, maxRetries: 3 }));
  const c = fixture({ stateDir, credentials: await createCredentials(stateDir) });
  let host = c.create();
  t.after(() => host.close());
  await c.options.credentials.set('JINBAO_USER_MODEL_API_KEY', 'fixture-model-key');
  await host.propose(c.room.id, { deviceName: '电脑', maxTokens: 50000 }); await host.close();
  const encoded = await readFile(join(stateDir, 'credentials.dpapi'), 'utf8');
  assert.doesNotMatch(encoded, /fixture-model-key|SSSSSS|deviceSecret|proposal-one/);
  c.options.credentials = await createCredentials(stateDir); host = c.create();
  await host.synchronize(c.room, c.grant);
  assert.equal(c.devices.length, 1); assert.equal(c.devices[0].credentials.deviceSecret, 'S'.repeat(43));
  assert.equal(c.sent.length, 1, 'restart reuses the approved device and does not create another proposal');
  await host.withdraw(c.room.id);
  assert.equal((await c.options.credentials.resolve('JINBAO_USER_MODEL_API_KEY')).value, 'fixture-model-key');
});

test('revocation closes the native host before deleting its files and preserving a local receipt', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'team-host-revoke-cache-')), cache = await createRoomCacheStore({ stateDir });
  const c = fixture({ stateDir, cacheStore: cache }), host = c.create();
  t.after(async () => { await host.close(); await cache.close(); await rm(stateDir, { recursive: true, force: true, maxRetries: 3 }); });
  await host.propose(c.room.id, { deviceName: '电脑', maxTokens: 50000 }); await host.synchronize(c.room, c.grant);
  await cache.authorize(c.room.id);
  const path = join(stateDir, 'team-host-sessions', createHash('sha256').update(c.room.id).digest('hex'));
  await mkdir(path, { recursive: true }); await writeFile(join(path, 'history.jsonl'), 'PRIVATE-HISTORY');
  const detach = cache.attach(() => { assert.ok(c.counts().stopped >= 1); return true; });
  await host.synchronize(c.room, { configured: false, proposals: [] }); detach();
  await assert.rejects(lstat(path), { code: 'ENOENT' }); assert.equal((await cache.receipts())[0].reason, 'authorization_ended');
  assert.doesNotMatch(JSON.stringify(await cache.receipts()), /PRIVATE-HISTORY|room-one|SSSSS/);
});

test('privacy version change clears the local host cache before reconnecting and rejects rollback', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'team-host-privacy-')), cache = await createRoomCacheStore({ stateDir });
  const c = fixture({ stateDir, cacheStore: cache }); let host = c.create();
  t.after(async () => { await host.close(); await cache.close(); await rm(stateDir, { recursive: true, force: true, maxRetries: 3 }); });
  await host.propose(c.room.id, { deviceName: '电脑', maxTokens: 50000 });
  await host.synchronize({ ...c.room, privacyVersion: 1 }, c.grant);
  await cache.authorize(c.room.id);
  const path = join(stateDir, 'team-host-sessions', createHash('sha256').update(c.room.id).digest('hex'));
  await mkdir(path, { recursive: true }); await writeFile(join(path, 'history.jsonl'), 'PRIVATE-OLD-CONTEXT');
  const previousStops = c.counts().stopped;
  const detach = cache.attach(() => { assert.ok(c.counts().stopped > previousStops); return true; });
  await host.preparePrivacy({ ...c.room, privacyVersion: 2 }); detach();
  await assert.rejects(lstat(path), { code: 'ENOENT' });
  assert.equal((await cache.receipts()).at(-1).reason, 'privacy_changed');
  await host.synchronize({ ...c.room, privacyVersion: 2 }, c.grant);
  assert.equal(host.view().state, 'connected');
  await host.close(); host = c.create();
  await assert.rejects(() => host.synchronize({ ...c.room, privacyVersion: 1 }, c.grant), /privacy_version_invalid/);
  assert.equal(host.view().state, 'cleanup_pending');
});

test('a failed native disposer cannot silently initialize a replacement host until the app restarts', async t => {
  let initialized = 0;
  const c = fixture({ runnerFactory: async () => { initialized++; return { close: async () => { throw new Error('fixture-dispose-failed'); } }; } });
  const host = c.create(); t.after(() => host.close());
  await host.propose(c.room.id, { deviceName: '电脑', maxTokens: 50000 }); await host.synchronize(c.room, c.grant);
  await assert.rejects(host.reconfigure());
  await assert.rejects(host.synchronize(c.room, c.grant), /local_host_restart_required/);
  assert.equal(initialized, 1);
});

test('RPC authorization loss clears the old computer cache even when the member still has another configured host', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'team-host-replaced-cache-')), cache = await createRoomCacheStore({ stateDir });
  const c = fixture({ stateDir, cacheStore: cache }), host = c.create();
  t.after(async () => { await host.close(); await cache.close(); await rm(stateDir, { recursive: true, force: true, maxRetries: 3 }); });
  await host.propose(c.room.id, { deviceName: '电脑', maxTokens: 50000 }); await host.synchronize(c.room, c.grant);
  await cache.authorize(c.room.id);
  const path = join(stateDir, 'team-host-sessions', createHash('sha256').update(c.room.id).digest('hex'));
  await mkdir(path, { recursive: true }); await writeFile(join(path, 'history.jsonl'), 'OLD-COMPUTER-HISTORY');
  c.devices[0].onStatus({ state: 'authorization_required' });
  await host.synchronize(c.room, c.grant);
  await assert.rejects(lstat(path), { code: 'ENOENT' }); assert.equal(c.devices.length, 1);
  assert.equal((await cache.receipts())[0].reason, 'authorization_ended'); assert.equal(c.values.size, 0);
});

test('quiescing immediately stops a connected device and disposes a late native initializer without proposing or starting work', async t => {
  const c = fixture(), host = c.create(); t.after(() => host.close());
  await host.propose(c.room.id, { deviceName: '电脑', maxTokens: 50000 }); await host.synchronize(c.room, c.grant);
  host.quiesce(); assert.equal(c.counts().stopped, 1); await host.close(); assert.equal(c.counts().stopped, 1);
  let release, began, disposed = 0;
  const entered = new Promise(resolve => { began = resolve; });
  const slow = fixture({ runnerFactory: () => { began(); return new Promise(resolve => { release = () => resolve({ close: async () => { disposed++; } }); }); } });
  const opening = slow.create(); t.after(() => opening.close());
  const pending = opening.propose(slow.room.id, { deviceName: '电脑', maxTokens: 50000 }), rejected = assert.rejects(pending, /team_closed/);
  await entered; opening.quiesce(); release(); await rejected; await opening.close();
  assert.equal(disposed, 1); assert.deepEqual(slow.sent, []); assert.deepEqual(slow.devices, []);
});
