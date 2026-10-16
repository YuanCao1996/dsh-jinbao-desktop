import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSetupServer } from '../server.mjs';

test('model proxy preserves large native Agent messages and tool pairs while enforcing a bounded request', async t => {
  const values = new Map([['JINBAO_SERVICE_TOKEN', 'jc_' + 'a'.repeat(64)]]); let forwarded;
  const setup = await createSetupServer({ port: 0, stateDir: await mkdtemp(join(tmpdir(), 'jinbao-budget-')),
    credentials: { resolve: async key => values.has(key) ? { value: values.get(key) } : undefined, set: async (key, value) => values.set(key, value) },
    fetchImpl: async (_url, options) => { forwarded = JSON.parse(options.body); return Response.json({ choices: [{ message: { content: 'ok' } }] }); },
  });
  t.after(setup.close);
  const url = new URL(setup.url);
  const post = messages => fetch(url.origin + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + values.get('JINBAO_LOCAL_ACCESS_KEY'), 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'jinbao-strategy', messages }) });
  const messages = [{ role: 'user', content: '观察'.repeat(30000) }, { role: 'assistant', content: null, tool_calls: [{ id: 'pair', type: 'function', function: { name: 'site_query', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'pair', content: '真实检索结果' }];
  assert.equal((await post(messages)).status, 200);
  assert.deepEqual(forwarded.messages, messages);
  forwarded = null;
  assert.equal((await post([{ role: 'user', content: 'x'.repeat(530000) }])).status, 413);
  assert.equal(forwarded, null);
});
