import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapHost } from '../host-bootstrap.mjs';
for (const scenario of ['success','http-error','truncated','oversize','cancel','signature-failure']) {
  test(`host bootstrap ${scenario}, cleans temporary installer`, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinbao-bootstrap-'));
    const controller = new AbortController();
    let installs = 0;
    const stages = [];
    const operation = bootstrapHost({ stateDir, signal: controller.signal,
      fetchImpl: async (_url, options) => {
        assert.equal(options.redirect, 'error');
        return new Response('MZfixture', { status: scenario === 'http-error' ? 503 : 200,
          headers: { 'content-length': scenario === 'truncated' ? '100' : scenario === 'oversize' ? '2000000000' : '9' } });
      },
      onProgress: value => { stages.push(value.stage); if(scenario === 'cancel') controller.abort(); },
      runInstaller: async file => {
        installs++;
        assert.equal(await readFile(file, 'utf8'), 'MZfixture');
        if(scenario === 'signature-failure') throw Error('invalid-signature');
      }
    });
    try {
      if(scenario === 'success') await operation;
      else await assert.rejects(operation);
      assert.equal(installs, ['success','signature-failure'].includes(scenario) ? 1 : 0);
      assert.deepEqual(await readdir(join(stateDir, 'host-installer')), []);
      if(scenario === 'success') assert.equal(stages.at(-1), 'install');
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });
}
