import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRoomCacheStore, ROOM_CACHE_MAX_AGE } from '../cache-store.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'team-cache-retention-')); let time = 1000;
  let store;
  t.after(async () => { await store?.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const directory = roomId => join(root, 'team-host-sessions', hash(roomId));
  const write = async roomId => { await mkdir(directory(roomId), { recursive: true }); await writeFile(join(directory(roomId), 'history.jsonl'), 'PRIVATE-GROUP-HISTORY'); };
  return { root, directory, write, now: () => time, advance: delta => { time += delta; }, setTime: value => { time = value; },
    async open(extra) { store = await createRoomCacheStore({ stateDir: root, now: () => time, ...extra }); return store; } };
}

test('expired local group caches are deleted on cold start without changing private sessions or room history elsewhere', async t => {
  const c = await fixture(t); let store = await c.open();
  await store.authorize('room-one'); await c.write('room-one');
  const personal = join(c.root, 'local-sessions'); await mkdir(personal); await writeFile(join(personal, 'keep'), 'PERSONAL');
  await store.close(); c.advance(ROOM_CACHE_MAX_AGE); store = await c.open();
  await assert.rejects(lstat(c.directory('room-one')), { code: 'ENOENT' });
  assert.equal(await readFile(join(personal, 'keep'), 'utf8'), 'PERSONAL');
  const receipts = await store.receipts(); assert.equal(receipts.length, 1); assert.equal(receipts[0].reason, 'expired');
  assert.doesNotMatch(JSON.stringify(receipts), /room-one|PRIVATE-GROUP-HISTORY|PERSONAL/);
  assert.doesNotMatch(await readFile(join(c.root, 'team-host-cache.json'), 'utf8'), /room-one|PRIVATE-GROUP-HISTORY/);
});

test('fresh authenticated use renews a cache while expired generations cannot be reused', async t => {
  const c = await fixture(t), store = await c.open(), first = await store.authorize('one'); await c.write('one');
  c.advance(ROOM_CACHE_MAX_AGE - 1); assert.deepEqual(await store.authorize('one'), first);
  c.advance(2); assert.deepEqual(await store.runOnce(), { deleted: 0, pending: 0 }); await store.assertActive(first);
  c.advance(ROOM_CACHE_MAX_AGE); await store.runOnce(); await assert.rejects(store.assertActive(first), /lease_ended/);
  const second = await store.authorize('one'); assert.equal(second.generation, first.generation + 1);
});

test('withdrawal produces one durable receipt and old files restored later are removed again', async t => {
  const c = await fixture(t), store = await c.open(); await store.authorize('one'); await c.write('one');
  await store.removeRoom('one', 'local_withdraw'); const first = await store.receipts();
  await store.removeRoom('one', 'local_withdraw'); assert.deepEqual(await store.receipts(), first);
  c.advance(60000); await c.write('one'); await store.runOnce(); assert.deepEqual(await store.receipts(), first);
  await assert.rejects(lstat(c.directory('one')), { code: 'ENOENT' });
  await store.authorize('one'); assert.deepEqual(await store.receipts(), first, 'reauthorization cannot drop an unsent local deletion receipt');
});

test('busy sessions are fenced before disposal and a restart retries the same durable deletion operation', async t => {
  const c = await fixture(t); let store = await c.open(); const lease = await store.authorize('one'); await c.write('one');
  const detach = store.attach(() => false);
  assert.equal(await store.removeRoom('one', 'authorization_ended'), false);
  assert.equal(await readFile(join(c.directory('one'), 'history.jsonl'), 'utf8'), 'PRIVATE-GROUP-HISTORY');
  await assert.rejects(store.assertActive(lease), /lease_ended/); assert.deepEqual(await store.receipts(), []);
  const operation = JSON.parse(await readFile(join(c.root, 'team-host-cache.json'), 'utf8')).entries[hash('one')].operationId;
  detach(); await store.close(); store = await c.open();
  assert.equal((await store.receipts())[0].id, operation);
  await assert.rejects(lstat(c.directory('one')), { code: 'ENOENT' });
});

test('unindexed old preview caches are purged without importing an SDK, resolving a key or using a network', async t => {
  const c = await fixture(t); await c.write('legacy');
  const script = join(c.root, 'storage-only.mjs');
  await writeFile(script, `import { createRoomCacheStore } from ${JSON.stringify(new URL('../cache-store.mjs', import.meta.url).href)};
globalThis.fetch = () => { throw Error('network_not_allowed'); };
const store = await createRoomCacheStore({stateDir:${JSON.stringify(c.root)}});
console.log(JSON.stringify(await store.receipts()));await store.close();`);
  const result = await promisify(execFile)(process.execPath, [script], { timeout: 10000, windowsHide: true });
  assert.match(result.stdout, /legacy_unindexed/); assert.doesNotMatch(result.stdout, /PRIVATE-GROUP-HISTORY/);
  await assert.rejects(lstat(c.directory('legacy')), { code: 'ENOENT' });
});

test('unsafe nested links remain pending and their external targets are never traversed or removed', async t => {
  const c = await fixture(t), store = await c.open(); await store.authorize('one'); await c.write('one');
  const outside = join(c.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'keep'), 'UNTOUCHED');
  const link = join(c.directory('one'), 'linked'); await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.removeRoom('one', 'access_ended'), /unsafe_room_cache_target/);
  assert.deepEqual(await store.receipts(), []); assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'UNTOUCHED');
  await unlink(link); assert.deepEqual(await store.runOnce(), { deleted: 1, pending: 0 });
  assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'UNTOUCHED');
});

test('a failed intent write prevents deletion and traversal inputs are rejected', async t => {
  const c = await fixture(t), store = await c.open(); await store.authorize('one'); await c.write('one');
  const file = join(c.root, 'team-host-cache.json'); await rm(file); await mkdir(file);
  await assert.rejects(store.removeRoom('one', 'access_ended'), /room_cache_index_invalid/);
  assert.equal(await readFile(join(c.directory('one'), 'history.jsonl'), 'utf8'), 'PRIVATE-GROUP-HISTORY');
  assert.equal(store.status().pending, 1); assert.equal(store.status().active, 0);
  await assert.rejects(store.removeRoom('../outside', 'access_ended'), /invalid_room_cache_cleanup/);
  await assert.rejects(store.removeRoom('another', 'invalid'), /invalid_room_cache_cleanup/); assert.equal(store.status().pending, 1);
  await rm(file, { recursive: true });
  await store.authorize('one');
  await assert.rejects(lstat(c.directory('one')), { code: 'ENOENT' });
  assert.equal(store.status().pending, 0);
});

test('a backwards local clock expires rather than indefinitely extending a previously verified cache', async t => {
  const c = await fixture(t), store = await c.open(); await store.authorize('one'); await c.write('one'); c.setTime(999);
  assert.deepEqual(await store.runOnce(), { deleted: 1, pending: 0 });
  assert.equal((await store.receipts())[0].reason, 'clock_changed');
});

test('corrupt metadata and a root junction fail closed without changing another directory', async t => {
  const c = await fixture(t); await writeFile(join(c.root, 'team-host-cache.json'), '{broken');
  await assert.rejects(c.open()); await rm(join(c.root, 'team-host-cache.json'));
  const outside = join(c.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'keep'), 'UNTOUCHED');
  const rootLink = join(c.root, 'team-host-sessions'); await symlink(outside, rootLink, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(c.open(), /unsafe_room_cache_root/); assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'UNTOUCHED');
  await unlink(rootLink);
});

test('files restored between sweeps are removed before authorization, including unindexed directories', async t => {
  const c = await fixture(t), store = await c.open();
  await c.write('unindexed'); await store.authorize('unindexed');
  await assert.rejects(lstat(c.directory('unindexed')), { code: 'ENOENT' });
  await c.write('unindexed'); await store.removeRoom('unindexed', 'access_ended');
  const receipts = await store.receipts(); await c.write('unindexed');
  await store.authorize('unindexed');
  await assert.rejects(lstat(c.directory('unindexed')), { code: 'ENOENT' });
  assert.deepEqual(await store.receipts(), receipts);
});

test('an earlier local index keeps its deletion receipt when upgraded and authorized for a fresh cache', async t => {
  const c = await fixture(t), operationId = '10000000-0000-0000-0000-000000000001';
  await writeFile(join(c.root, 'team-host-cache.json'), JSON.stringify({ schemaVersion: 1, entries: { [hash('old')]: {
    generation: 1, lastAuthorizedAt: 0, expiresAt: 0, state: 'deleted', reason: 'local_withdraw', operationId, deletedAt: 500 } } }));
  const store = await c.open(); assert.equal((await store.receipts())[0].id, operationId);
  await store.authorize('old'); await store.close();
  const reopened = await c.open(); assert.equal((await reopened.receipts())[0].id, operationId);
});

test('explicit fresh host consent clears an existing cache and does not invent a deletion for a brand new room', async t => {
  const c = await fixture(t), store = await c.open();
  await store.clearBeforeGrant('new-room'); assert.deepEqual(await store.receipts(), []);
  await store.authorize('old'); await c.write('old'); await store.clearBeforeGrant('old');
  await assert.rejects(lstat(c.directory('old')), { code: 'ENOENT' }); assert.equal((await store.receipts())[0].reason, 'new_authorization');
});
