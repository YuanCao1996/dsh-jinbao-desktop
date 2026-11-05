import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicExperienceHandler } from '../public-experience-handler.mjs';

// 假的 req/res：网关靠返回值决定是否继续往下传，所以这两件事都要能被断言。
function fakeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return { method, url, async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; } };
}
function fakeRes() {
  const state = { status: 0, headers: null, body: '' };
  return { state, writeHead(status, headers) { state.status = status; state.headers = headers; }, end(body) { state.body = body; } };
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'jinbao-pub-handler-'));
  const handler = createPublicExperienceHandler({ dir, allowRead: true });
  return { dir, handler };
}

test('requests that are not ours fall through to the next gateway handler', async () => {
  const { dir, handler } = await fixture();
  try {
    const res = fakeRes();
    assert.equal(await handler(fakeReq('GET', '/api/cloud-agent'), res), false);
    assert.equal(res.state.status, 0, 'no response is written for foreign routes');
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

test('a lesson posted to the gateway is stored and readable', async () => {
  const { dir, handler } = await fixture();
  try {
    const lesson = { kind: 'recognition', claim: '高光遮挡时先取前后两帧比对再判定', scope: ['game:lol'], patch: null, evidence: { games: 2, hits: 2, counter: 0 } };
    const post = fakeRes();
    assert.equal(await handler(fakeReq('POST', '/api/public/experience', { lessons: [lesson] }), post), true);
    assert.equal(post.state.status, 200);
    const result = JSON.parse(post.state.body);
    assert.equal(result.added, 1);
    const get = fakeRes();
    await handler(fakeReq('GET', '/api/public/experience?game=lol&limit=5'), get);
    const listed = JSON.parse(get.state.body).lessons;
    assert.equal(listed.length, 1);
    assert.ok(listed[0].evidence.games === 2);
    const md = await readFile(join(dir, 'public', 'recognition.md'), 'utf8');
    assert.match(md, /两帧/);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

test('private lessons are refused and the gateway keeps serving', async () => {
  const { dir, handler } = await fixture();
  try {
    const res = fakeRes();
    await handler(fakeReq('POST', '/api/public/experience', { lessons: [{ kind: 'preference', claim: '喜欢激进开团', player: 'me' }] }), res);
    assert.equal(res.state.status, 200);
    assert.equal(JSON.parse(res.state.body).rejected[0].reason, 'private-kind');
    const empty = fakeRes();
    await handler(fakeReq('GET', '/api/public/experience?game=lol'), empty);
    assert.equal(JSON.parse(empty.state.body).lessons.length, 0);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

test('a write policy can require a token without blocking anonymous reads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jinbao-pub-auth-'));
  try {
    const handler = createPublicExperienceHandler({ dir, allowRead: true, authorize: (req) => req.headers?.authorization === 'Bearer good' });
    const lesson = { kind: 'recognition', claim: '高光遮挡时先取前后两帧比对再判定', scope: ['game:lol'], evidence: { games: 1, hits: 1, counter: 0 } };
    const write = (authorization) => {
      const req = fakeReq('POST', '/api/public/experience', { lessons: [lesson] });
      req.headers = authorization ? { authorization } : {};
      return req;
    };
    const denied = fakeRes();
    assert.equal(await handler(write(null), denied), true);
    assert.equal(denied.state.status, 401);
    const readWhileEmpty = fakeRes();
    await handler(fakeReq('GET', '/api/public/experience?game=lol'), readWhileEmpty);
    assert.equal(JSON.parse(readWhileEmpty.state.body).lessons.length, 0, 'nothing was written by the rejected call');
    const allowed = fakeRes();
    await handler(write('Bearer good'), allowed);
    assert.equal(allowed.state.status, 200);
    assert.equal(JSON.parse(allowed.state.body).added, 1);
    const read = fakeRes();
    await handler(fakeReq('GET', '/api/public/experience?game=lol'), read);
    assert.equal(JSON.parse(read.state.body).lessons.length, 1, 'anonymous read still works');
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

test('malformed bodies and wrong methods are answered, not thrown', async () => {
  const { dir, handler } = await fixture();
  try {
    const del = fakeRes();
    assert.equal(await handler(fakeReq('DELETE', '/api/public/experience'), del), true);
    assert.equal(del.state.status, 405);
    const bad = fakeRes();
    const broken = { method: 'POST', url: '/api/public/experience', async *[Symbol.asyncIterator]() { yield Buffer.from('{not json'); } };
    assert.equal(await handler(broken, bad), true);
    assert.equal(bad.state.status, 400);
    assert.equal(JSON.parse(bad.state.body).error, 'bad-request');
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

test('read is disabled by default so experience text never leaves the server', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jinbao-pub-noread-'));
  try {
    const handler = createPublicExperienceHandler({ dir });
    const res = fakeRes();
    assert.equal(await handler(fakeReq('GET', '/api/public/experience?game=lol'), res), true);
    assert.equal(res.state.status, 403);
    assert.equal(JSON.parse(res.state.body).error, 'read-disabled');
    // 写入仍然允许（客户端需要贡献），只是读不到原文
    const write = fakeRes();
    await handler(fakeReq('POST', '/api/public/experience', { lessons: [{ kind: 'recognition', claim: '高光遮挡时先取前后两帧比对', scope: ['game:lol'], evidence: { games: 1, hits: 1, counter: 0 } }] }), write);
    assert.equal(write.state.status, 200);
    assert.equal(JSON.parse(write.state.body).added, 1);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});
