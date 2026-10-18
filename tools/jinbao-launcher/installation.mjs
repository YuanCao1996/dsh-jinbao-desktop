import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const plugins = ['dsh-onboarding', 'dsh-coach-server', 'dsh-game-services'];
export function installationAction({current,hostRunning,pluginInstalled}){
  if(current)return 'reuse';
  if(!hostRunning)return 'install';
  return pluginInstalled?'defer':'wait';
}

// Match the installer's copy filter; compare every shipped module, including new files.
export async function installationCurrent(root, profiles) {
  async function matches(source, installed) {
    for (const entry of await readdir(source, { withFileTypes: true })) {
      const from = join(source, entry.name);
      if (entry.name === 'tests' || entry.name.includes('.bak')) continue;
      const to = join(installed, entry.name);
      if (entry.isDirectory()) {
        if (!await matches(from, to)) return false;
      } else if (!(await readFile(from)).equals(await readFile(to))) return false;
    }
    return true;
  }
  try {
    for (const plugin of plugins) {
      if (!await matches(join(root, 'tools', plugin), join(profiles, 'node_modules', plugin))) return false;
    }
    return true;
  } catch { return false; }
}

export function createHostRecovery({ now = Date.now, retryMs = 30000 } = {}) {
  let nextAttempt = 0;
  return {
    shouldStart(running) {
      if (running) { nextAttempt = 0; return false; }
      if (now() < nextAttempt) return false;
      nextAttempt = now() + retryMs;
      return true;
    },
  };
}
