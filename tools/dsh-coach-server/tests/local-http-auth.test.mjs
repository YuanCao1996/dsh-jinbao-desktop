import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { guardCoachRequest } from '../lib/local-http-auth.js';
import { assertReleaseRuntime } from '../../desktop-release/runtime-policy.mjs';

test('local coach HTTP rejects web origins, missing credentials and unused desktop routes before work', async t => {
  let calls = 0;
  let unavailable = false;
  const credentials = { resolve: async () => { if (unavailable) throw Error('locked'); return { value: 'test-private-local-token' }; } };
  const server = http.createServer(async (req, res) => {
    if (!await guardCoachRequest(req, res, { credentials, port: server.address().port, desktop: true })) return;
    calls++;
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  const auth = { Authorization: 'Bearer test-private-local-token' };
  async function check(path, options, status) {
    const response = await fetch(base + path, options);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    await response.text();
  }
  await check('/coach/state', {}, 401);
  await check('/coach/chat', { method: 'POST' }, 401);
  await check('/coach/state', { headers: { ...auth, Origin: 'https://untrusted.invalid' } }, 403);
  const hostileHost = await new Promise((resolve, reject) => {
    const req = http.get(base + '/coach/state', { headers: { ...auth, Host: 'untrusted.invalid' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(hostileHost, 403);
  await check('/ai/generate', { method: 'POST', headers: auth }, 404);
  await check('/coach/control', { method: 'POST', headers: auth }, 404);
  await check('/coach/stream', { headers: auth }, 404);
  await check('/coach/state', { method: 'OPTIONS', headers: { Origin: 'https://untrusted.invalid' } }, 403);
  await check('/coach/state', { headers: { Authorization: 'Bearer wrong' } }, 401);
  unavailable = true;
  await check('/coach/state', { headers: auth }, 503);
  unavailable = false;
  assert.equal(calls, 0);
  await check('/coach/state', { headers: auth }, 200);
  await check('/coach/chat', { method: 'POST', headers: auth }, 200);
  assert.equal(calls, 2);
});

test('release runtime gate rejects the vulnerable runtime and unreviewed major versions', () => {
  for (const version of ['v24.14.0', '24.22.0', '22.23.4', '26.12.1', 'invalid']) assert.throws(() => assertReleaseRuntime(version));
  for (const version of ['v24.22.1', '24.23.0']) assert.doesNotThrow(() => assertReleaseRuntime(version));
});
