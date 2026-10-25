import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import http from 'node:http';
import { createHash } from 'node:crypto';

const folder = process.argv[2];
const { createSdkHost, validateModelConfig } = await import(pathToFileURL(join(folder, 'tools/generic-game-assistant/experiment/sdk-host.mjs')));
const { createDshAnalyzer } = await import(pathToFileURL(join(folder, 'tools/generic-game-assistant/dsh.mjs')));
assert.equal(validateModelConfig({}), null);
assert.throws(() => validateModelConfig({ baseURL: 'http://remote.invalid', model: 'x', apiKey: 'x' }), /invalid_model_endpoint/);
const require = createRequire(pathToFileURL(join(folder, 'package.json')));
const { LlmAdapter } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')));
const requests = [];
class FixtureAdapter extends LlmAdapter {
  async *stream(options) {
    requests.push(options);
    const block = { type: 'tool-call', id: 'fixture-'+requests.length,
      name: requests.length === 1 ? 'generic_read_state' : 'generic_reply',
      arguments: requests.length === 1 ? '{}' : JSON.stringify({ text: '黑子位于棋盘中心；执子尚未确认。' }) };
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
    yield { type: 'block-end', index: 0, block };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  }
}
const id = 'generic-gomoku-12345678-1234-1234-1234-123456789abc';
const host = await createSdkHost({ stateDir: join(folder, 'state'), adapter: new FixtureAdapter(),
  observer: { clear() {} }, specializedActive: async () => false, timeoutMs: 5000 });
const analyzer = createDshAnalyzer(host.ctx, { enabled: true, runtime: { status: () => ({ session_id: id }),
  state: () => ({ status: 'observed', facts: { player_color: 'unknown' } }) },
  provider: 'generic-model', model: 'fixture-model', cwd: join(folder, 'state'), timeoutMs: 5000 });
try {
  const result = await analyzer.analyze({ system: '仅解释已观察事实', context: { game: 'gomoku', session_id: id, user_question: '观察棋盘' } });
  assert.equal(result, '黑子位于棋盘中心；执子尚未确认。');
  assert.equal(requests.length, 2);
  assert.equal(host.ctx.tools.get('generic_read_state'), undefined);
  assert.ok(requests.every(r => r.tools.every(t => /^generic_/.test(t.name))));
  assert.ok(await host.ctx.sessionPersistence.stat(id));
  const second = await analyzer.analyze({ system: '仅解释已观察事实',
    context: { game: 'gomoku', session_id: id, user_question: '我之前问了什么' } });
  assert.equal(second, '黑子位于棋盘中心；执子尚未确认。');
  assert.equal(requests.length, 3);
  assert.equal(host.ctx.sessions.list().length, 1);
  assert.ok(JSON.stringify(requests[2].messages).includes('观察棋盘'));
} finally { await analyzer.close(); await host.close(); }

const wireRequests = [];
const wire = http.createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer fixture-key');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks));
    wireRequests.push(request);
    assert.equal(request.model, 'fixture-model');
    assert.ok(request.tools.every(tool => /^generic_/.test(tool.function.name)));
    assert.equal(request.stream, true);
    const number = wireRequests.length;
    assert.ok(number <= 2, 'no repeated tool-reply loop');
    const tool = number === 1 ? 'generic_read_state' : 'generic_reply';
    const args = number === 1 ? '{}' : JSON.stringify({ text: '当前只确认棋盘观察，未确认轮到谁。' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: '+JSON.stringify({ id: 'fixture-response-'+number, model: 'fixture-model',
      choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'wire-'+number,
        type: 'function', function: { name: tool, arguments: args } }] }, finish_reason: null }] })+'\n\n');
    res.write('data: '+JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })+'\n\n');
    res.end('data: [DONE]\n\n');
  } catch { res.writeHead(500); res.end(); }
});
await new Promise(resolve => wire.listen(0, '127.0.0.1', resolve));
let wireHost, wireAnalyzer;
try {
  wireHost = await createSdkHost({ stateDir: join(folder, 'wire-state'),
    modelConfig: { baseURL: 'http://127.0.0.1:'+wire.address().port+'/v1', model: 'fixture-model', apiKey: 'fixture-key' },
    observer: { clear() {} }, specializedActive: async () => false, timeoutMs: 8000 });
  wireAnalyzer = createDshAnalyzer(wireHost.ctx, { enabled: true, runtime: { status: () => ({ session_id: id }),
    state: () => ({ status: 'observed', facts: { player_color: 'unknown' } }) },
    provider: 'generic-model', model: 'fixture-model', cwd: join(folder, 'wire-state'), timeoutMs: 8000 });
  const text = await wireAnalyzer.analyze({ system: '仅解释已观察事实', context: { game: 'gomoku', session_id: id, user_question: '看棋盘' } });
  assert.equal(text, '当前只确认棋盘观察，未确认轮到谁。');
  assert.equal(wireRequests.length, 2);
  assert.ok(wireRequests[1].messages.some(message => message.role === 'tool'));
  console.log('full_host_check_passed real_agent=true real_http=true external_cloud=false');
} finally {
  await wireAnalyzer?.close(); await wireHost?.close();
  await new Promise(resolve => { wire.close(resolve); wire.closeAllConnections(); });
}

const proxyRequests = [];
const proxyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTz8AAAAASUVORK5CYII=', 'base64');
let strategyCalls = 0, imageCalls = 0;
const realFetch = globalThis.fetch;
let proxyHost, proxyAnalyzer;
globalThis.fetch = async (input, init) => {
  const incoming = new Request(input, init);
  assert.equal(incoming.url, 'https://api.jinbaoai.top/v1/chat/completions');
  assert.equal(incoming.headers.get('authorization'), 'Bearer jc_' + '1'.repeat(64));
  const body = await incoming.json();
  proxyRequests.push(body);
  const allowed = new Set(['model', 'messages', 'tools', 'tool_choice', 'temperature', 'max_tokens',
    'stream', 'stream_options', 'store', 'parallel_tool_calls']);
  assert.ok(Object.keys(body).every(key => allowed.has(key)), 'matches strict desktop proxy schema');
  assert.equal(body.model, 'game-fast');
  assert.ok(body.max_tokens <= 2048);
  if (!body.tools) {
    imageCalls++;
    assert.equal(body.messages[1].content[1].image_url.url, 'data:image/png;base64,'+proxyPng.toString('base64'));
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      screen_kind: 'other', game_name: null, visual_status: 'partial', texts: ['测试文字'], entities: [],
    }) } }] });
  }
  assert.ok(body.tools.every(tool => /^generic_/.test(tool.function.name)));
  const number = ++strategyCalls;
  assert.ok(number <= 2);
  const tool = number === 1 ? 'generic_read_screen' : 'generic_reply';
  const args = number === 1 ? '{}' : JSON.stringify({ text: '图中可见文字：测试文字。' });
  const deltas = [
    { role: 'assistant', reasoning_content: 'Use confirmed screen facts only.' },
    { tool_calls: [{ index: 0, id: 'proxy-'+number, type: 'function', function: { name: tool, arguments: args } }] },
  ];
  const data = deltas.map(delta => 'data: '+JSON.stringify({ id: 'proxy-response-'+number,
    model: 'deepseek-v4.1-flash', choices: [{ index: 0, delta, finish_reason: null }] })+'\n\n').join('')
    + 'data: '+JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })+'\n\n'
    + 'data: [DONE]\n\n';
  return new Response(data, { headers: { 'Content-Type': 'text/event-stream' } });
};
try {
  proxyHost = await createSdkHost({ stateDir: join(folder, 'proxy-state'), sharedModel: {
    provider: 'jinbao-server', model: 'game-fast', baseURL: 'https://api.jinbaoai.top/v1',
    credentialRef: 'FIXTURE_PROXY_TOKEN', resolveCredential: async () => ({ value: 'jc_' + '1'.repeat(64) }),
  }, observer: { clear() {}, select: async () => ({ kind: 'window', id: 'proxy-fixture', width: 10, height: 10, authorized: true }),
    capture: async () => ({ png: proxyPng, image: { width: 1, height: 1, rgb: new Uint8Array(3) }, geometry: {},
      frame: { target_id: 'proxy-fixture', width: 1, height: 1, captured_at_ms: Date.now(), assistant_excluded: true,
        sha256: createHash('sha256').update(proxyPng).digest('hex') } }) }, specializedActive: async () => false, timeoutMs: 8000 });
  await proxyHost.runtime.start({ targetId: 'proxy-fixture', authorized: true, allowCloudImages: true });
  const answered = await proxyHost.runtime.ask('Read authorized screen');
  assert.equal(answered.status, 'completed');
  assert.equal(answered.text, '图中可见文字：测试文字。');
  assert.equal(proxyRequests.length, 3); assert.equal(imageCalls, 1);
  const finalRequest = proxyRequests.at(-1);
  assert.ok(finalRequest.messages.some(message => message.role === 'tool'));
  assert.ok(finalRequest.messages.every(message => !Array.isArray(message.content)), 'images stay outside DSH history');
  assert.ok(finalRequest.messages.some(message => message.role === 'assistant'
    && message.reasoning_content === 'Use confirmed screen facts only.'));
  console.log('desktop_proxy_wire_check_passed real_agent=true external_cloud=false');
} finally {
  await proxyAnalyzer?.close(); await proxyHost?.close();
  globalThis.fetch = realFetch;
}
