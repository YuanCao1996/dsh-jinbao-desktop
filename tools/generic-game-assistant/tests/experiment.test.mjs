import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareExperiment } from '../experiment/prepare.mjs';
import { createExperimentServer } from '../experiment/server.mjs';

test('experiment HTTP entry rejects foreign origins, missing nonce and oversized bodies; model is never faked', async () => {
  const host = { modelReady: false, runtime: { status: () => ({ session_id: null }), state: () => ({ status: 'unknown' }) },
    windows: { list: async () => [] }, close: async () => {}, stop: async () => {} };
  const app = await createExperimentServer({ host, port: 0 });
  const u = new URL(app.url), token = u.hash.slice(1), base = u.origin;
  try {
    assert.equal((await fetch(base+'/')).status, 200);
    assert.equal((await fetch(base+'/api/status')).status, 403);
    const headers = { 'x-generic-session': token, 'Content-Type': 'application/json' };
    assert.equal((await fetch(base+'/api/status', { headers: { ...headers, Origin: 'https://evil.invalid' } })).status, 403);
    assert.equal((await fetch(base+'/api/status', { headers })).status, 200);
    assert.equal((await fetch(base+'/api/ask', { method: 'POST', headers, body: JSON.stringify({ question: '棋盘如何' }) })).status, 409);
    assert.equal((await fetch(base+'/api/start', { method: 'POST', headers, body: JSON.stringify({ value: 'x'.repeat(9000) }) })).status, 413);
  } finally { await app.close(); }
});

test('complete isolated SDK drives real AgentLoop and native tools, persisting only its own session', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'jinbao-generic-host-test-'));
  try {
    const folder = await prepareExperiment({ parent });
    // The native SDK loads DLLs. Exit the isolated process before cleaning its copied SDK.
    const { stdout } = await promisify(execFile)(process.execPath,
      [fileURLToPath(new URL('./fixtures/full-host-check.mjs', import.meta.url)), folder],
      { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
    assert.match(stdout, /full_host_check_passed/);
  } finally {
    const resolved = await realpath(parent);
    assert.equal(dirname(resolved), await realpath(tmpdir()));
    assert.ok(basename(resolved).startsWith('jinbao-generic-host-test-'));
    await rm(resolved, { recursive: true, force: true });
  }
});

test('image permission can be revoked through authenticated HTTP while a question is in flight', async () => {
  let finish, started;
  const begun = new Promise(resolve => { started = resolve; });
  let allowed = true;
  const host = { modelReady: true, windows: { list: async () => [] }, stop: async () => {}, close: async () => {},
    runtime: { status: () => ({ session_id: 'fixture' }), state: () => ({ status: 'unknown' }),
      ask: async () => { started(); return new Promise(resolve => { finish = resolve; }); },
      setImagePermission: value => { if (typeof value !== 'boolean') throw new Error('invalid_image_permission'); allowed = value; return { allowed }; } } };
  const app = await createExperimentServer({ host, port: 0 });
  const url = new URL(app.url), headers = { 'x-generic-session': url.hash.slice(1), 'Content-Type': 'application/json' };
  const post = (path, body) => fetch(url.origin+'/api/'+path, { method: 'POST', headers, body: JSON.stringify(body) });
  let request;
  try {
    request = post('ask', { question: 'Read screen' }); await begun;
    assert.equal((await post('image-permission', { allowed: false })).status, 200);
    assert.equal(allowed, false);
    assert.equal((await post('image-permission', { allowed: 'true' })).status, 400);
    finish({ status: 'completed', text: 'fixture' });
    assert.equal((await request).status, 200);
  } finally { finish?.({ status: 'cancelled' }); await request; await app.close(); }
});
