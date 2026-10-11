import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';

test('IPC stop and parent disconnect clean the owned descendant process', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'jinbao-process-'));
  const path = join(dir, 'collector.mjs');
  const helper = new URL('../../desktop-release/owned-process.mjs', import.meta.url).href;
  await writeFile(path, `import {spawn} from 'node:child_process';
import {bindOwnedChild} from ${JSON.stringify(helper)};
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
bindOwnedChild(child,()=>{});
process.send({pid:child.pid});`);
  for (const action of ['stop', 'disconnect']) {
    const collector = fork(path, { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    t.after(() => { if (collector.exitCode === null && collector.signalCode === null) collector.kill(); });
    const [{ pid }] = await once(collector, 'message', { signal: AbortSignal.timeout(5000) });
    const exited = once(collector, 'exit', { signal: AbortSignal.timeout(5000) });
    if (action === 'stop') collector.send({ action: 'stop' }); else collector.disconnect();
    await exited;
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
});
