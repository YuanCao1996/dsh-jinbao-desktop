import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSetupServer } from '../server.mjs';
const stateDir = await mkdtemp(join(tmpdir(), 'jinbao-probe-'));
await mkdir(join(stateDir, 'logs'), { recursive: true });
const values = new Map([['JINBAO_SERVICE_TOKEN', 'jc_' + 'a'.repeat(64)]]);
const server = await createSetupServer({ port: 0, stateDir,
  credentials: { resolve: async (k) => (values.has(k) ? { value: values.get(k) } : undefined), set: async (k, v) => values.set(k, v) },
  fetchImpl: async () => Response.json({ choices: [{ message: { content: 'ok' } }] }) });
const origin = new URL(server.url).origin;
const nonce = new URL(server.url).hash.slice(1);
try {
  for (const [label, url, init] of [
    ['GET 无 nonce', origin + '/api/public/experience?game=lol', undefined],
    ['GET 带 nonce', origin + '/api/public/experience?game=lol', { headers: { 'x-jinbao-setup': nonce } }],
  ]) {
    const response = await fetch(url, init);
    const text = await response.text();
    console.log(label, '→', response.status, JSON.stringify(text.slice(0, 120)));
  }
} finally { await server.close(); await rm(stateDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
process.exit(0);
