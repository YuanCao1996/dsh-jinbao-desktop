import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCaptureIdentity } from '../../desktop-release/capture-state.mjs';

test('same phone resumes match identity; other phones and expired captures remain isolated', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'jinbao-capture-'));
  let time = 10000;
  const options = { folder, serial: 'private-phone-A', now: () => time };
  const first = createCaptureIdentity({ ...options, newSource: () => 'wzry-first' });
  assert.equal(first.identify({ seconds: 1000, at: time }).match, 'wzry-first#1');
  first.save(true); time += 20000;
  const resumed = createCaptureIdentity({ ...options, newSource: () => 'wzry-second' });
  assert.equal(resumed.identify({ seconds: 1020, at: time }).match, 'wzry-first#1');
  const other = createCaptureIdentity({ ...options, serial: 'phone-B', newSource: () => 'wzry-other' });
  assert.equal(other.identify({ seconds: 1020, at: time }).match, 'wzry-other#1');
  const files = await readdir(folder);
  assert.ok(files.every(name => !name.includes('private-phone-A')));
  for (const file of files) assert.ok(!(await readFile(join(folder, file), 'utf8')).includes('private-phone-A'));
  time += 31 * 60 * 1000;
  const expired = createCaptureIdentity({ ...options, newSource: () => 'wzry-expired' });
  assert.equal(expired.identify({ seconds: 20, at: time }).match, 'wzry-expired#1');
});

test('reconnecting after a mid-game new match detects rollback beyond the opening two minutes', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'jinbao-rollback-'));
  let time = 10000;
  const options = { folder, serial: 'phone', now: () => time, newSource: () => 'wzry-first' };
  const first = createCaptureIdentity(options);
  first.identify({ seconds: 1400, at: time }); first.save(true);
  time += 60000;
  const resumed = createCaptureIdentity(options);
  assert.equal(resumed.identify({ seconds: 400, at: time }).pending, true);
  time += 1000;
  assert.equal(resumed.identify({ seconds: 401, at: time }).match, 'wzry-first#2');
  resumed.identify({ ended: true, at: ++time }); resumed.save(true);
  const ended = createCaptureIdentity(options);
  assert.equal(ended.identify({ seconds: 402, at: ++time }).ended, true);
  assert.equal(ended.identify({ started: true, at: ++time }).match, 'wzry-first#3');
  assert.equal(ended.identify({ seconds: 0, at: ++time }).ended, false);
});

test('unidentified devices do not share a recovery file and metadata write failure does not stop capture', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'jinbao-no-serial-'));
  const first = createCaptureIdentity({ folder, newSource: () => 'wzry-first' });
  first.identify({ seconds: 100, at: 10000 }); first.save(true);
  assert.deepEqual(await readdir(folder), []);
  const broken = createCaptureIdentity({ folder: join(folder, 'missing'), serial: 'phone', newSource: () => 'wzry-safe' });
  assert.equal(broken.identify({ seconds: 100, at: 10000 }).match, 'wzry-safe#1');
  assert.equal(broken.save(true), false);
});
