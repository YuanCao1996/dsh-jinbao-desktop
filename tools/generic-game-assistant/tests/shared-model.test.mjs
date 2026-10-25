import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadSharedModel } from '../experiment/shared-model.mjs';

const root = process.platform === 'win32' ? 'C:\\fixture-dsh' : '/fixture-dsh';
const token = 'jc_' + '1'.repeat(64);
const refreshed = 'jd_' + '2'.repeat(64);

test('desktop proxy selects its login reference and game-fast alias without loading upstream/admin keys', async () => {
  let text = `version: 1\nrefs:\n  JINBAO_SERVICE_TOKEN: ${token}\n  OPENCODE_GO_API_KEY: unrelated-fixture\n`;
  const paths = [];
  const config = await loadSharedModel({ dshHome: root, sessionToken: undefined,
    read: async path => { paths.push(path); return text; } });
  assert.equal(config.model, 'game-fast');
  assert.equal(config.summary.upstream_model, 'deepseek-v4.1-flash');
  assert.equal(config.baseURL, 'https://api.jinbaoai.top/v1');
  assert.equal((await config.resolveCredential()).value, token);
  assert.doesNotMatch(JSON.stringify(config), new RegExp(`${token}|unrelated-fixture`));
  assert.ok(paths.every(path => path === join(root, '.credentials.yaml')));
  text = `version: 1\nrefs:\n  JINBAO_SERVICE_TOKEN: ${refreshed}\n`;
  assert.equal((await config.resolveCredential()).value, refreshed);
});

test('private development session is reread and checked for expiry before every request', async () => {
  let time = 1000;
  let text = JSON.stringify({ sessionToken: token, expiresAt: 2000 });
  const config = await loadSharedModel({ sessionFile: join(root, 'session.json'), now: () => time,
    read: async () => text });
  assert.equal(config.summary.mode, 'jinbao_server_development_session');
  assert.equal((await config.resolveCredential()).value, token);
  assert.ok(!JSON.stringify(config).includes(token));
  text = JSON.stringify({ sessionToken: refreshed, expiresAt: 2000 });
  assert.equal((await config.resolveCredential()).value, refreshed);
  time = 2000;
  await assert.rejects(config.resolveCredential(), /^Error: jinbao_server_credential_unavailable$/);
});

test('missing, malformed, expired and legacy admin credentials fail closed without revealing values', async () => {
  for (const text of ['invalid-json', '{}', JSON.stringify({ sessionToken: token, expiresAt: 10 }),
    JSON.stringify({ sessionToken: 'admin-secret', expiresAt: Date.now() + 10000 })]) {
    await assert.rejects(loadSharedModel({ sessionFile: join(root, 'session.json'), read: async () => text }),
      error => error.message === 'jinbao_server_credential_unavailable');
  }
  await assert.rejects(loadSharedModel({ dshHome: root, read: async () => { throw new Error('secret-path'); } }),
    error => error.message === 'jinbao_server_credential_unavailable');
  await assert.rejects(loadSharedModel({ dshHome: root, sessionToken: 'admin-secret' }),
    error => error.message === 'jinbao_server_credential_unavailable');
  await assert.rejects(loadSharedModel({ dshHome: root,
    read: async () => `version: 1\nrefs:\n  JINBAO_SERVER_SESSION_TOKEN: ${token}\n  API_BEARER_TOKEN: admin-secret\n` }),
    error => error.message === 'jinbao_server_credential_unavailable');
  await assert.rejects(loadSharedModel({ sessionFile: 'relative.json' }), /absolute_credential_path_required/);
});
