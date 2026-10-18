import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from 'yaml';
import { installCoachPreset } from '../../desktop-release/coach-preset.mjs';
import { configureGameAgent } from '../../dsh-coach-server/lib/agent-profile.js';

test('game preset uses native DSH compaction with budgets valid for the configured 32k model', () => {
  const doc = parseDocument('[]'); installCoachPreset(doc, []);
  const preset = doc.toJS()[0].insert[0].config;
  assert.equal(preset.id, 'jinbao-game');
  assert.ok(!JSON.stringify(preset).includes('terminal'));
  const compact = preset.plugins.find(p => p.name.endsWith('dsh-compaction-basic')).config;
  assert.ok((compact.headroomTokens??0) + compact.maxTokens < 32768);
  assert.ok(compact.retainRatio < compact.thresholdRatio);
  const web = preset.plugins.find(p => p.name.endsWith('dsh-tool-web'));
  assert.equal(web.config.search, true); assert.equal(web.config.fetch, true);
});

test('preset-owned web tools remain in the native agent capability filter', () => {
  let filter;
  const names = ['site_datasets', 'site_query', 'web_search', 'web_fetch'];
  const ctx = { tools: { get: name => names.includes(name), view: () => ({ restrictableNames: new Set(names) }), restrict: value => filter = value, presentAs() {} } };
  configureGameAgent(ctx, 'jinbao-game');
  assert.deepEqual(filter.allow, names);
});

test('agent keeps available retrieval tools and uses native schemas without exposing unrelated host tools', () => {
  let filter, mode;
  const ctx = { tools: { get: name => ['site_query', 'site_datasets'].includes(name), restrict: value => filter = value, presentAs: value => mode = value } };
  configureGameAgent(ctx, 'jinbao-game');
  assert.deepEqual(filter.allow, ['site_datasets', 'site_query']); assert.equal(mode, 'native');
  assert.throws(() => configureGameAgent({ tools: { get: () => null } }, 'jinbao-game'), /not available/);
});
