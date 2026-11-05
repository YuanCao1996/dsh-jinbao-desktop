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
  const handler = createPublicExperienceHandler({ dir, allowRead: true, allowPending: true, authorize: async () => true });
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

test('a token policy gates both write and read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jinbao-pub-auth-'));
  try {
    const handler = createPublicExperienceHandler({ dir, allowRead: true, allowPending: true, authorize: (req) => req.headers?.authorization === 'Bearer good' });
    const lesson = { kind: 'recognition', claim: '高光遮挡时先取前后两帧比对再判定', scope: ['game:lol'], evidence: { games: 1, hits: 1, counter: 0 } };
    const request = (method, authorization) => {
      const req = fakeReq(method, '/api/public/experience' + (method === 'GET' ? '?game=lol' : ''), method === 'POST' ? { lessons: [lesson] } : undefined);
      req.headers = authorization ? { authorization } : {};
      return req;
    };
    const deniedWrite = fakeRes();
    await handler(request('POST', null), deniedWrite);
    assert.equal(deniedWrite.state.status, 401, 'writes need the token');
    const deniedRead = fakeRes();
    await handler(request('GET', null), deniedRead);
    assert.equal(deniedRead.state.status, 401, 'reads need the token too');
    const allowedWrite = fakeRes();
    await handler(request('POST', 'Bearer good'), allowedWrite);
    assert.equal(allowedWrite.state.status, 200);
    assert.equal(JSON.parse(allowedWrite.state.body).added, 1);
    const allowedRead = fakeRes();
    await handler(request('GET', 'Bearer good'), allowedRead);
    assert.equal(allowedRead.state.status, 200);
    assert.equal(JSON.parse(allowedRead.state.body).lessons.length, 1);
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
    const handler = createPublicExperienceHandler({ dir, authorize: async () => true });
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

test('uploads are attributed so three independent accounts can promote a lesson', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jinbao-pub-attr-'));
  try {
    const handler = createPublicExperienceHandler({ dir, allowRead: true, authorize: async () => true, identify: async (req) => req.headers?.['x-account'] ?? null });
    const lesson = { kind: 'recognition', claim: '高光遮挡时先取前后两帧比对再判定', scope: ['game:lol'], evidence: { games: 1, hits: 1, counter: 0 } };
    const upload = async (account) => {
      const req = fakeReq('POST', '/api/public/experience', { lessons: [lesson] });
      req.headers = account ? { 'x-account': account } : {};
      const res = fakeRes();
      await handler(req, res);
      return JSON.parse(res.state.body);
    };
    assert.equal((await upload('a')).added, 1);
    await upload('a');
    await upload('a');
    const pendingOnly = fakeRes();
    await handler(fakeReq('GET', '/api/public/experience?game=lol'), pendingOnly);
    assert.equal((JSON.parse(pendingOnly.state.body).lessons ?? []).length, 0, 'one account cannot promote its own lesson');
    await upload('b');
    await upload('c');
    const promoted = fakeRes();
    await handler(fakeReq('GET', '/api/public/experience?game=lol'), promoted);
    assert.equal(JSON.parse(promoted.state.body).lessons.length, 1, 'three distinct accounts promote it');
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

test('anonymous writes are refused, authenticated ones are stored', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jinbao-pub-writeauth-'));
  try {
    const lesson = { kind: 'recognition', claim: '高光遮挡时先取前后两帧比对', scope: ['game:lol'], evidence: { games: 1, hits: 1, counter: 0 } };
    const closed = createPublicExperienceHandler({ dir, authorize: async () => false });
    const denied = fakeRes();
    await closed(fakeReq('POST', '/api/public/experience', { lessons: [lesson] }), denied);
    assert.equal(denied.status ?? denied.state.status, 401);
    const noHook = createPublicExperienceHandler({ dir });
    const denied2 = fakeRes();
    await noHook(fakeReq('POST', '/api/public/experience', { lessons: [lesson] }), denied2);
    assert.equal(denied2.state.status, 401, 'without an authorize hook nothing may be written');
    const open = createPublicExperienceHandler({ dir, authorize: async () => true, allowRead: true, allowPending: true });
    const allowed = fakeRes();
    await open(fakeReq('POST', '/api/public/experience', { lessons: [lesson] }), allowed);
    assert.equal(allowed.state.status, 200);
    assert.equal(JSON.parse(allowed.state.body).added, 1);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});
