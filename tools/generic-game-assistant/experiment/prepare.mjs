import { cp, mkdir, mkdtemp, realpath, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export async function prepareExperiment({ parent, sdkRoot } = {}) {
  const source = fileURLToPath(new URL('../../../', import.meta.url));
  if (!parent) parent = join(source, 'workspace/generic-game');
  if (!sdkRoot) {
    const require = createRequire(import.meta.url);
    sdkRoot = dirname(dirname(dirname(require.resolve('@deepseek-ai/dsh/package.json'))));
  }
  const dependencies = await realpath(sdkRoot);
  await mkdir(parent, { recursive: true });
  const folder = await mkdtemp(join(parent, 'experiment-'));
  // Copy a complete dependency closure from ONE installed SDK. No links, package installation or credential copies.
  const copied = new Set();
  async function copyPackage(name, optional = false) {
    if (copied.has(name)) return;
    const sourcePackage = join(dependencies, name);
    let manifest;
    try { manifest = JSON.parse(await readFile(join(sourcePackage, 'package.json'), 'utf8')); }
    catch (error) { if (optional && error.code === 'ENOENT') return; throw error; }
    copied.add(name);
    await cp(sourcePackage, join(folder, 'node_modules', name), { recursive: true });
    for (const dependency of Object.keys(manifest.dependencies ?? {})) await copyPackage(dependency);
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) await copyPackage(dependency, true);
    for (const dependency of Object.keys(manifest.peerDependencies ?? {})) await copyPackage(dependency, true);
  }
  for (const name of ['cordis', 'dsh-agent', 'dsh-agent-loop', 'dsh-session', 'dsh-session-projection',
    'dsh-system-prompt', 'dsh-tools', 'dsh-llm', 'dsh-session-persistence-jsonl', 'dsh-llm-pi-ai', 'dsh-credentials-local']) {
    await copyPackage('@deepseek-ai/' + name);
  }
  await writeFile(join(folder, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  for (const name of ['generic-game-assistant', 'game-observation']) {
    await cp(join(source, 'tools', name), join(folder, 'tools', name), { recursive: true,
      filter: path => !/[\\/]tests(?:[\\/]|$)/.test(path) });
  }
  await mkdir(join(folder, 'tools/dsh-coach-server/lib'), { recursive: true });
  for (const path of ['package.json', 'lib/session-runtime.js']) {
    await cp(join(source, 'tools/dsh-coach-server', path), join(folder, 'tools/dsh-coach-server', path));
  }
  return folder;
}
