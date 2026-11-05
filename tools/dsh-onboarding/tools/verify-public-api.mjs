#!/usr/bin/env node
// 起一个随机端口的 setup server，用真实 HTTP 打公有经验库：首次新增、重复只累加、读回、私有被拒。
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSetupServer } from '../server.mjs';

const stateDir = await mkdtemp(join(tmpdir(), 'jinbao-verify-public-'));
await mkdir(join(stateDir, 'logs'), { recursive: true });
const values = new Map([['JINBAO_SERVICE_TOKEN', 'jc_' + 'a'.repeat(64)]]);
const server = await createSetupServer({
  port: 0, stateDir,
  credentials: { resolve: async (key) => (values.has(key) ? { value: values.get(key) } : undefined), set: async (key, value) => values.set(key, value) },
  fetchImpl: async () => Response.json({ choices: [{ message: { content: 'ok' } }] }),
});
const parsed = new URL(server.url);const origin = parsed.origin;const nonce = parsed.hash.slice(1);
const lesson = { fingerprint: 'verify-1', kind: 'recognition', claim: '高光遮挡时先取前后两帧比对再判定', scope: ['game:lol'], patch: null, evidence: { games: 2, hits: 2, counter: 0 } };
const post = async (body) => (await fetch(origin + '/api/public/experience', { method: 'POST', headers: { 'content-type': 'application/json', 'x-jinbao-setup': nonce }, body: JSON.stringify(body) })).json();
try {
  const first = await post({ lessons: [lesson] });
  const again = await post({ lessons: [lesson] });
  const getResponse = await fetch(origin + '/api/public/experience?game=lol&limit=5', { headers: { 'x-jinbao-setup': nonce } });
  const got = await getResponse.json();
  if (!getResponse.ok) console.log('GET 状态:', getResponse.status, JSON.stringify(got));
  const row = (got.lessons || []).find((entry) => entry.claim.includes('两帧'));
  const bad = await post({ lessons: [{ kind: 'preference', claim: '喜欢激进开团' }] });
  console.log('首次:', JSON.stringify({ added: first.added, updated: first.updated }));
  console.log('重复:', JSON.stringify({ added: again.added, updated: again.updated }));
  console.log('读回:', row ? JSON.stringify({ games: row.evidence.games, confidence: row.confidence }) : '未读到');
  console.log('私有被拒:', JSON.stringify(bad.rejected));
  const ok = first.added === 1 && again.updated === 1 && again.added === 0 && row && row.evidence.games === 4 && bad.rejected.length === 1;
  console.log(ok ? 'VERIFY-OK' : 'VERIFY-FAIL');
} finally {
  await server.close();
  await rm(stateDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
process.exit(0);
