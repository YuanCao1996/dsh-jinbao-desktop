import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installationCurrent, createHostRecovery } from '../installation.mjs';

test('upgrade detection covers nested helpers and newly added plugin files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tests-jinbao-install-'));
  const profiles = join(root, 'profiles');
  for (const name of ['dsh-onboarding', 'dsh-coach-server', 'dsh-game-services']) {
    const source = join(root, 'tools', name);
    await mkdir(join(source, 'lib'), { recursive: true });
    await writeFile(join(source, 'lib', 'helper.js'), 'original');
    await cp(source, join(profiles, 'node_modules', name), { recursive: true });
  }
  assert.equal(await installationCurrent(root, profiles), true);
  const helper = join(root, 'tools/dsh-coach-server/lib/helper.js');
  await writeFile(helper, 'updated');
  assert.equal(await installationCurrent(root, profiles), false);
  await writeFile(join(profiles, 'node_modules/dsh-coach-server/lib/helper.js'), 'updated');
  assert.equal(await installationCurrent(root, profiles), true);
  await writeFile(join(root, 'tools/dsh-game-services/new-client.mjs'), 'new');
  assert.equal(await installationCurrent(root, profiles), false);
});

test('host recovery waits for startup, retries failures, and recovers a later crash', () => {
  let time = 0;
  const recovery = createHostRecovery({ now: () => time });
  assert.equal(recovery.shouldStart(false), true);
  time = 10000;
  assert.equal(recovery.shouldStart(false), false);
  time = 30000;
  assert.equal(recovery.shouldStart(false), true);
  assert.equal(recovery.shouldStart(true), false);
  time = 31000;
  assert.equal(recovery.shouldStart(false), true);
});
