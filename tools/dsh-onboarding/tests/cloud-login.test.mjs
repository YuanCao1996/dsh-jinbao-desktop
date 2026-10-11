import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSetupServer } from '../server.mjs';

test('website device login defaults to cloud, renews a valid session and preserves a deliberate BYOK choice', async t => {
  const values = new Map();
  const oldToken = 'jd_' + 'a'.repeat(64);
  const newToken = 'jd_' + 'b'.repeat(64);
  let authorizationUrl = 'https://open.weixin.qq.com/connect/qrconnect?state=opaque';
  const calls = [];
  let renewFails = false;
  let monitorReady = false;
  const credentials = { resolve: async key => values.has(key) ? { value: values.get(key) } : undefined,
    set: async (key, value) => values.set(key, value), unset: async key => values.delete(key) };
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname; calls.push({ path, options });
    if (path.endsWith('/capabilities')) return Response.json({ enabled: true });
    if (path.endsWith('/wechat/start')) return Response.json({ authorizationUrl, deviceSecret: 'private-device-secret', expiresIn: 300 });
    if (path.endsWith('/poll')) return Response.json({ status: 'approved', sessionToken: oldToken, expiresIn: 604800 });
    if (path.endsWith('/renew')) return renewFails ? Response.json({}, { status: 503 }) : Response.json({ sessionToken: newToken, expiresIn: 604800 });
    if (path === '/coach/state') return Response.json({ monitor: { ready: monitorReady } });
    if (path.endsWith('/account')) return Response.json({ features: { model: true, retrieval: false } });
    return Response.json({ ok: true });
  };
  const stateDir = await mkdtemp(join(tmpdir(), 'jinbao-login-'));
  const setup = await createSetupServer({ stateDir, credentials, fetchImpl, port: 0 });
  t.after(setup.close);
  const [base, nonce] = setup.url.split('/#');
  const request = (path, data) => fetch(base + '/api/' + path, { method: data === undefined ? 'GET' : 'POST',
    headers: { 'X-Jinbao-Setup': nonce, 'Content-Type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const initial = await (await request('status')).json();
  assert.equal(initial.mode, 'cloud'); assert.equal(initial.wechatEnabled, true);
  assert.equal(initial.coachReady, false);
  monitorReady = true;
  assert.equal((await (await request('status')).json()).coachReady, true);
  const login = await (await request('login/wechat/start', {})).json();
  assert.equal(login.authorizationUrl, authorizationUrl); assert.ok(!JSON.stringify(login).includes('private-device-secret'));
  assert.equal((await request('login/poll', {})).status, 200);
  await writeFile(join(stateDir, 'cloud-login.json'), JSON.stringify({ expiresAt: Date.now() + 3600000, renewAfter: 0 }));
  await request('status');
  assert.equal(values.get('JINBAO_SERVICE_TOKEN'), newToken);
  assert.equal(calls.find(call => call.path.endsWith('/renew')).options.headers.Authorization, 'Bearer ' + oldToken);
  renewFails = true;
  await writeFile(join(stateDir, 'cloud-login.json'), JSON.stringify({ expiresAt: Date.now() + 3600000, renewAfter: 0 }));
  const beforeFailure = calls.filter(call => call.path.endsWith('/renew')).length;
  await request('status'); await request('status');
  assert.equal(calls.filter(call => call.path.endsWith('/renew')).length, beforeFailure + 1);
  assert.equal(values.get('JINBAO_SERVICE_TOKEN'), newToken);
  await request('model', { mode: 'byok', baseUrl: 'https://vendor.test/v1', model: 'test', apiKey: 'private-key' });
  await request('login/wechat/start', {}); await request('login/poll', {});
  assert.equal((await (await request('status')).json()).mode, 'byok');
  authorizationUrl = 'https://evil.test/connect/qrconnect';
  assert.equal((await request('login/wechat/start', {})).status, 502);
});
