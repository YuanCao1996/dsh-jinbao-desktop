import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExperienceToolkit, parseMd } from '../experience-tools.mjs';

const dirOf = () => mkdtemp(join(tmpdir(), 'jinbao-desk-xp-'));

test('public kinds are refused in the desktop toolkit', async () => {
  const dir = await dirOf();
  try {
    const kit = createExperienceToolkit({ dir, player: 'local' });
    assert.equal(parseMd('- [0.5|2局|candidate] 甲').length, 1);
    assert.equal((await kit.saveMd({ kind: 'build', mdText: '- [0.5|1局|candidate] 乙' })).reason, 'private-only');
    assert.equal((await kit.editLine({ kind: 'build', from: '甲', to: '丙', reason: '测试理由' })).reason, 'private-only');
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

test('saving md retires removed lines and adds new ones with one game of evidence', async () => {
  const dir = await dirOf();
  try {
    const kit = createExperienceToolkit({ dir, player: 'local' });
    assert.equal((await kit.saveMd({ kind: 'preference', mdText: '- [0.6|3局|candidate] 喜欢激进开团' })).added, 1);
    const second = await kit.saveMd({ kind: 'preference', mdText: '- [0.5|1局|candidate] 现在想稳一点' });
    assert.equal(second.retired, 1);
    assert.equal(second.added, 1);
    const rows = await kit.listPrivate();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].claim, '现在想稳一点');
    assert.equal(rows[0].evidence.games, 1);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

test('an agent edit needs a reason and a matching source line', async () => {
  const dir = await dirOf();
  try {
    const kit = createExperienceToolkit({ dir, player: 'local' });
    await kit.saveMd({ kind: 'pitfall', mdText: '- [0.5|1局|candidate] 五分钟后单独推线被抓' });
    assert.equal((await kit.editLine({ kind: 'pitfall', from: '五分钟后单独推线被抓', to: '新的结论', reason: '' })).reason, 'reason-required');
    assert.equal((await kit.editLine({ kind: 'pitfall', from: '不存在的行', to: '新的结论', reason: '这条已经过时了' })).reason, 'not-found');
    const ok = await kit.editLine({ kind: 'pitfall', from: '五分钟后单独推线被抓', to: '五分钟后先退塔后等兵线', reason: '14.21 该机制已改' });
    assert.equal(ok.ok, true);
    assert.match(await kit.readMd('pitfall'), /先退塔后等兵线/);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});
