import { mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const installerUrl = 'https://download.deepseek.com/desktop/dsh-latest-windows-x64.exe';
const maxBytes = 1024 * 1024 * 1024;
export async function downloadInstaller(file, { signal, onProgress = () => {}, fetchImpl = fetch } = {}) {
  const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15 * 60 * 1000)]);
  const response = await fetchImpl(installerUrl, { signal: bounded, redirect: 'error' });
  if (!response.ok || !response.body) throw Error('download-failed');
  const total = Number(response.headers.get('content-length')) || 0;
  if (total < 0 || total > maxBytes) { await response.body.cancel(); throw Error('invalid-size'); }
  const handle = await open(file, 'wx');
  let received = 0;
  try {
    for await (const chunk of response.body) {
      bounded.throwIfAborted();
      received += chunk.length;
      if (received > maxBytes) throw Error('invalid-size');
      await handle.writeFile(chunk);
      onProgress({ stage: 'download', received, total });
    }
    bounded.throwIfAborted();
    if (!received || (total && total !== received)) throw Error('incomplete-download');
  } finally { await handle.close(); }
}
export async function bootstrapHost({ stateDir, signal, onProgress = () => {}, runInstaller, fetchImpl }) {
  const folder = join(stateDir, 'host-installer');
  await mkdir(folder, { recursive: true });
  const file = join(folder, `dsh-${randomUUID()}.exe`);
  try {
    onProgress({ stage: 'download', received: 0, total: 0 });
    await downloadInstaller(file, { signal, onProgress, fetchImpl });
    signal?.throwIfAborted();
    onProgress({ stage: 'install' });
    await runInstaller(file);
  } finally { await rm(file, { force: true }); }
}
