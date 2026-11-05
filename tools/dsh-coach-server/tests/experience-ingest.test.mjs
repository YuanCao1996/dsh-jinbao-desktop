import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factsFromLogs, ingest } from '../tools/experience-ingest.mjs';

async function stateWith(lines) {
  const dir = await mkdtemp(join(tmpdir(), 'jinbao-ingest-'));
  await mkdir(join(dir, 'logs'), { recursive: true });
  await writeFile(join(dir, 'logs', 'lol-live-1.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return dir;
}

const ENDED = [
  { match: 'm1', kind: 'load', me: { champion: '祖安狂人 蒙多医生' } },
  { match: 'm1', kind: 'death' },
  { match: 'm1', kind: 'death' },
  { match: 'm1', kind: 'augment_capture_blind' },
  { match: 'm1', kind: 'game_end' },
];

test('only facts the logs can prove are derived', async () => {
  const dir = await stateWith(ENDED);
  try {
    const facts = await factsFromLogs(dir, { outcome: 'win' });
    assert.equal(facts.ended, true);
    assert.equal(facts.match, 'm1');
    assert.equal(facts.champion, '祖安狂人 蒙多医生');
    assert.equal(facts.deaths, 2);
    assert.equal(facts.recognition.blindFrames, 1);
    assert.equal(facts.outcome, 'win', 'the outcome is a caller claim, never inferred from logs');
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('an unfinished match is refused instead of learning from a half game', async () => {
  const dir = await stateWith(ENDED.slice(0, 2));
  try {
    const result = await ingest({ stateDir: dir, outcome: 'win' });
    assert.equal(result.action, 'not-finished');
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('a finished match with a known result writes the champion records to disk', async () => {
  const dir = await stateWith(ENDED);
  try {
    const result = await ingest({ stateDir: dir, outcome: 'loss', player: 'p1' });
    assert.equal(result.action, 'stored');
    assert.ok(result.stored.stored >= 1);
    const stats = await readFile(join(dir, 'experience', 'private', 'p1', 'stats.md'), 'utf8');
    assert.match(stats, /蒙多医生 战绩记录/);
    const index = await readFile(join(dir, 'experience', 'index.jsonl'), 'utf8');
    assert.match(index, /蒙多医生/);
    // Feeding the same match twice must not double the evidence.
    const again = await ingest({ stateDir: dir, outcome: 'loss', player: 'p1' });
    assert.equal(again.stored.action, 'duplicate');
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('--dry remembers nothing but still previews the pack', async () => {
  const dir = await stateWith(ENDED);
  try {
    const result = await ingest({ stateDir: dir, outcome: 'win', dry: true });
    assert.equal(result.action, 'dry-run');
    await assert.rejects(readFile(join(dir, 'experience', 'index.jsonl'), 'utf8'));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
