import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readdir,utimes,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pruneEventLogs,pruneCaptureFrames} from '../eventlog.mjs';

// Ten days of play left 59 match logs and 160MB in the state folder because nothing ever
// removed them. The collector now prunes at start-up; these pin the rules.

async function makeLogs(dir, count, {ageDays = 0} = {}) {
  await mkdir(dir, { recursive: true });
  const at = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
  const names = [];
  for (let i = 0; i < count; i += 1) {
    const name = `lol-live-${1000 + i}.jsonl`;
    await writeFile(join(dir, name), '{"kind":"state"}\n');
    await utimes(join(dir, name), at, new Date(at.getTime() + i * 1000));
    names.push(name);
  }
  return names;
}

test('old logs beyond the limit are removed and the recent ones stay', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'jinbao-prune-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await makeLogs(dir, 12);
  const result = pruneEventLogs(dir, { maxFiles: 5 });
  assert.equal(result.removed.length, 7);
  assert.equal(result.kept, 5);
  const left = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'));
  assert.equal(left.length, 5);
  // The newest file must survive a prune; the session may still be reading it.
  assert.ok(left.includes('lol-live-1011.jsonl'));
});

test('logs older than the age limit go even when few remain', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'jinbao-prune-age-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await makeLogs(dir, 3, { ageDays: 30 });
  const result = pruneEventLogs(dir, { maxFiles: 40, maxAgeDays: 14 });
  assert.equal(result.removed.length, 3, 'thirty-day-old logs are past the age limit');
});

test('a fresh short log list is left untouched', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'jinbao-prune-keep-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await makeLogs(dir, 4);
  const result = pruneEventLogs(dir);
  assert.equal(result.removed.length, 0);
  assert.equal(result.kept, 4);
});

test('a missing folder is not an error', () => {
  const result = pruneEventLogs(join(tmpdir(), 'jinbao-no-such-folder-' + process.pid));
  assert.deepEqual(result.removed, []);
});

test('old frame folders are pruned but the newest and the archive stay', async (t) => {
 // Frame evidence folders had the same no-cleanup problem as the match logs.
 const dir = await mkdtemp(join(tmpdir(), 'jinbao-frames-'));
 t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
 const names = [];
 for (let i = 0; i < 8; i += 1) {
   const name = 'card-watch-' + (1000 + i) + '-picked-1';
   await mkdir(join(dir, name));
   await writeFile(join(dir, name, 'baseline.png'), 'x');
   const at = new Date(Date.now() - (8 - i) * 60 * 1000);
   await utimes(join(dir, name), at, at);
   names.push(name);
 }
 await mkdir(join(dir, 'card-watch-archive-match1'));
 const result = pruneCaptureFrames(dir, { maxDirs: 3 });
 assert.equal(result.removed.length, 5);
 const left = (await readdir(dir)).filter((name) => name.startsWith('card-watch-'));
 assert.ok(left.includes('card-watch-1007-picked-1'), 'the newest folder must survive');
 assert.ok(left.includes('card-watch-archive-match1'), 'a named archive is never touched');
 assert.equal(left.length, 4);
});
