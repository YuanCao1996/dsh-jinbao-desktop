import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExperienceStore } from '../lib/experience-store.js';
import { syncPublicMemory } from '../lib/public-remote.mjs';

const json = (value, status = 200) => ({ ok: status < 400, status, json: async () => value });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'jinbao-pub-remote-'));
  const store = createExperienceStore({ dir });
  return { dir, store };
}

test('a sync uploads only shareable lessons and merges what comes back', async () => {
  const { dir, store } = await fixture();
  try {
    await store.remember({ kind: 'build', claim: '对面双坦先补重伤', scope: ['game:lol'], patch: '14.21' });
    await store.remember({ kind: 'preference', player: 'local', claim: '喜欢激进开团', scope: ['game:lol'] });
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, method: options?.method ?? 'GET', body: options?.body });
      if (options?.method === 'POST') return json({ accepted: 1, added: 1, updated: 0 });
      return json({ lessons: [{ fingerprint: 'r1', kind: 'recognition', claim: '高光遮挡时先双帧比对', scope: ['game:lol'], patch: null, evidence: { games: 3, hits: 3, counter: 0 } }] });
    };
    const result = await syncPublicMemory({ store, dir, baseUrl: 'http://server', fetchImpl, patch: '14.21' });
    assert.equal(result.uploaded, 1);
    assert.equal(result.rejected, 1, 'the preference stays home');
    const uploaded = JSON.parse(calls[0].body).lessons;
    assert.equal(uploaded.length, 1);
    assert.equal(uploaded[0].claim, '对面双坦先补重伤');
    assert.equal(result.fetched, 1);
    assert.equal(result.merged.merged, 1);
    assert.equal(calls[1].url.includes('patch=14.21'), true, 'the query carries the patch');
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

test('syncing twice does not inflate the remote lesson', async () => {
  const { dir, store } = await fixture();
  try {
    const fetchedLesson = { fingerprint: 'r1', kind: 'recognition', claim: '高光遮挡时先双帧比对', scope: ['game:lol'], patch: null, evidence: { games: 3, hits: 3, counter: 0 } };
    const fetchImpl = async (url, options) => (options?.method === 'POST' ? json({}) : json({ lessons: [fetchedLesson] }));
    await syncPublicMemory({ store, dir, baseUrl: 'http://server', fetchImpl });
    const second = await syncPublicMemory({ store, dir, baseUrl: 'http://server', fetchImpl });
    assert.equal(second.merged.merged, 0);
    const row = store.snapshot().find((entry) => entry.kind === 'recognition');
    assert.equal(row.evidence.games, 3);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

test('an unreachable server degrades to a local-only library', async () => {
  const { dir, store } = await fixture();
  try {
    await store.remember({ kind: 'build', claim: '对面双坦先补重伤', scope: ['game:lol'] });
    const offline = async () => { throw new Error('ECONNREFUSED'); };
    const result = await syncPublicMemory({ store, dir, baseUrl: 'http://server', fetchImpl: offline });
    assert.equal(result.error, 'upload-threw');
    assert.equal(store.snapshot().length, 1, 'local knowledge is untouched');
    const noEndpoint = await syncPublicMemory({ store, dir });
    assert.equal(noEndpoint.skipped, 'no-endpoint');
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});
