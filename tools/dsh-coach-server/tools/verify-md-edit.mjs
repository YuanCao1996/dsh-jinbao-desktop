#!/usr/bin/env node
// 在真实状态目录的**副本**上验证“改 md → 注入内容随之变化”，不动用户数据。
import { cp, mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExperienceStore } from '../lib/experience-store.js';

const stateDir = process.argv[2];
if (!stateDir) { console.error('用法: node verify-md-edit.mjs <stateDir>'); process.exit(2); }
const sandbox = await mkdtemp(join(tmpdir(), 'jinbao-md-verify-'));
const dir = join(sandbox, 'experience');
try {
  await cp(join(stateDir, 'experience'), dir, { recursive: true }).catch(() => {});
  const store = createExperienceStore({ dir });
  await store.load();
  // 若真实库里还没有私有经验，先放两条进去作为对照
  if (!store.snapshot().some((row) => row.kind === 'preference')) {
    await store.remember({ kind: 'preference', player: 'local', claim: '喜欢激进开团', scope: ['game:lol'] });
    await store.remember({ kind: 'preference', player: 'local', claim: '尽量不用否定句', scope: ['game:lol'] });
  }
  const before = await store.retrieve({ tags: ['game:lol'], player: 'local' });
  console.log('改之前注入:');
  for (const line of before.lines) console.log('  ' + line);
  const md = (await readFile(join(dir, 'private', 'local', 'preference.md'), 'utf8').catch(() => ''))
    .split(String.fromCharCode(10))
    .filter((line) => line.trim() && !line.includes('不用否定句'))
    .join(String.fromCharCode(10)) + String.fromCharCode(10) + '- [0.5|1局|candidate] 喜欢稳一点，先发育再打' + String.fromCharCode(10);
  const result = await store.applyMdEdit({ kind: 'preference', player: 'local', mdText: md, by: 'player', reason: '手动调整' });
  console.log('写回结果: 退役=' + result.retired + ' 新增=' + result.added + ' 记注=' + result.note);
  const after = await store.retrieve({ tags: ['game:lol'], player: 'local' });
  console.log('改之后注入:');
  for (const line of after.lines) console.log('  ' + line);
  const stale = after.lines.some((line) => line.includes('不用否定句'));
  const fresh = after.lines.some((line) => line.includes('先发育再打'));
  console.log(stale || !fresh ? 'VERIFY-FAIL' : 'VERIFY-OK');
} finally {
  await rm(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
process.exit(0);
