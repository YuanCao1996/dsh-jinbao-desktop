import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, unlink, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyDependency } from '../../desktop-release/dependency-copy.mjs';

test('complete shared dependencies remain untouched; incomplete links fail without external writes; regular installs can be repaired', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinbao-dependency-'));
  try {
    const source = join(root, 'source'), shared = join(root, 'shared'), linked = join(root, 'linked'), regular = join(root, 'regular');
    for (const dir of [source, shared, regular]) await mkdir(dir);
    await writeFile(join(source, 'entry.js'), 'bundled');
    await writeFile(join(shared, 'entry.js'), 'keep shared');
    await symlink(shared, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await copyDependency(source, linked);
    assert.equal(await readFile(join(shared, 'entry.js'), 'utf8'), 'keep shared');
    await unlink(join(shared, 'entry.js'));
    await assert.rejects(copyDependency(source, linked), /incomplete/);
    await assert.rejects(access(join(shared, 'entry.js')));
    await copyDependency(source, regular);
    assert.equal(await readFile(join(regular, 'entry.js'), 'utf8'), 'bundled');
  } finally { await rm(root, { recursive: true, force: true, maxRetries:3, retryDelay:100 }); }
});
