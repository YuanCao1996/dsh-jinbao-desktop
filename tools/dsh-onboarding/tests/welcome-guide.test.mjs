import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSetupServer } from '../server.mjs';

// Fixtures used to stay in the OS temp directory after the run. Register every created
// directory and delete them once, so a full suite does not slowly fill the system drive.
const mkdtempImpl = mkdtemp;
const tempDirs = [];
after(async () => {
  for (const dir of tempDirs) {
    try { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  }
});
const mkdtempTracked = async (prefix) => { const dir = await mkdtempImpl(prefix); tempDirs.push(dir); return dir; };


async function setup(t){
  const stateDir = await mkdtempTracked(join(tmpdir(), 'jinbao-welcome-'));
  const values = new Map([['JINBAO_SERVICE_TOKEN', 'jc_' + 'a'.repeat(64)]]);
  const server = await createSetupServer({
    port: 0, stateDir,
    credentials: { resolve: async key => values.has(key) ? { value: values.get(key) } : undefined, set: async (key, value) => values.set(key, value) },
    fetchImpl: async () => Response.json({ choices: [{ message: { content: 'ok' } }] }),
  });
  t.after(server.close);
  const url = new URL(server.url);
  return { origin: url.origin, nonce: url.hash.slice(1), stateDir };
}

test('the welcome guide is served with real screenshots behind a filename allowlist', async t => {
  const { origin } = await setup(t);

  const page = await fetch(origin + '/welcome');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  const html = await page.text();
  assert.match(html, /新手引导/);
  // Every step image referenced must be one of the shipped screenshots. The page keeps
  // them in its STEPS array and interpolates /welcome/<name> at render time.
  const refs = [...html.matchAll(/image:'([a-z]+\.png)'/g)].map(match => match[1]);
  // The guide must only document the tabs the overlay actually has: the equipment page
  // was removed and the events/chat pages were merged into the battle page.
  assert.deepEqual([...new Set(refs)].sort(), ['advice.png', 'augments.png', 'players.png']);
  assert.match(html, /\/welcome\/\$\{esc\(step\.image\)\}/);

  for (const name of ['advice.png', 'augments.png', 'players.png']) {
    const image = await fetch(origin + '/welcome/' + name);
    assert.equal(image.status, 200, name);
    assert.equal(image.headers.get('content-type'), 'image/png', name);
    assert.ok((await image.arrayBuffer()).byteLength > 1000, name);
  }
});

test('the welcome route refuses anything outside the screenshot allowlist', async t => {
  const { origin } = await setup(t);

  assert.equal((await fetch(origin + '/welcome/server.mjs')).status, 403, 'non-png falls through to the nonce gate');
  assert.equal((await fetch(origin + '/welcome/nope.png')).status, 404, 'unknown png name is rejected');
  assert.equal((await fetch(origin + '/welcome/..%2Fpackage.json')).status, 403);
  // fetch() normalises '..' before sending, so this legitimately resolves to an allowed
  // file; it documents that normalisation, it is not a bypass.
  assert.equal((await fetch(origin + '/welcome/augments.png/../players.png')).status, 200);
  // Percent-encoded traversal that survives normalisation must not serve anything.
  const encoded = await fetch(origin + '/welcome/%2E%2E%2Fpackage.json');
  assert.ok([403, 404].includes(encoded.status), 'encoded traversal must be refused, got ' + encoded.status);
  assert.doesNotMatch(await encoded.text(), /"name"\s*:\s*"dsh-onboarding"/);
});

test('marking the guide as seen is persisted and reported to the settings page', async t => {
  const { origin, nonce } = await setup(t);
  const headers = { 'X-Jinbao-Setup': nonce, 'Content-Type': 'application/json' };

  const before = await (await fetch(origin + '/api/status', { headers })).json();
  assert.equal(before.welcomeSeen, false);

  const seen = await fetch(origin + '/api/welcome/seen', { method: 'POST', headers, body: '{}' });
  assert.equal(seen.status, 200);
  assert.equal((await seen.json()).seen, true);

  const after = await (await fetch(origin + '/api/status', { headers })).json();
  assert.equal(after.welcomeSeen, true);
});

test('marking as seen requires the setup nonce', async t => {
  const { origin } = await setup(t);
  const denied = await fetch(origin + '/api/welcome/seen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 403);
});

test('the guide documents exactly the tabs the overlay defines', async () => {
  // The guide drifted once already: the equipment tab was removed and events/chat were merged
  // into the battle page, but the screenshots and steps still showed six pages. Reading both
  // sources keeps the count honest without hand-maintained numbers.
  const fs = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const here = fileURLToPath(new URL('.', import.meta.url));
  const overlay = await fs.readFile(join(here, '..', '..', 'desktop-release', 'strategy-overlay.ps1'), 'utf8');
  const tabLine = overlay.match(/foreach\(\$entry in @\((.+?)\)\)\{/s);
  assert.ok(tabLine, 'the overlay tab definition must stay findable');
  const tabs = [...tabLine[1].matchAll(/\(\s*'([a-z]+)'\s*,\s*'([^']+)'\s*\)/g)].map((match) => match[1]);
  assert.ok(tabs.length >= 3, 'unexpected tab definition: ' + tabLine[1].slice(0, 120));
  const page = await fs.readFile(join(here, '..', 'welcome.html'), 'utf8');
  const steps = [...page.matchAll(/image:'([a-z]+\.png)'/g)].map((match) => match[1]);
  assert.equal(steps.length, tabs.length, 'the guide must show one step per tab, tabs=' + JSON.stringify(tabs) + ' steps=' + JSON.stringify(steps));
  for (const tab of tabs) {
    assert.ok(steps.includes(tab + '.png'), 'missing screenshot for tab ' + tab);
  }
});
