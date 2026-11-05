import test from 'node:test';
import assert from 'node:assert/strict';
import { experienceRoute, experienceListPayload, correctRequest } from '../experience-routes.mjs';

test('each method and path reaches exactly one handler', () => {
  assert.equal(experienceRoute('GET', '/api/experience').action, 'list');
  assert.equal(experienceRoute('get', '/api/experience?x=1').action, 'list', 'query string is ignored');
  assert.equal(experienceRoute('POST', '/api/experience').action, 'method-not-allowed');
  assert.equal(experienceRoute('POST', '/api/experience/correct').action, 'correct');
  assert.equal(experienceRoute('GET', '/api/experience/correct').action, 'method-not-allowed');
  assert.equal(experienceRoute('GET', '/api/speech').action, 'none', 'other routes fall through');
});

test('the list payload is exactly what the settings page renders', () => {
  const payload = experienceListPayload([
    { id: 'a', kind: 'build', claim: '对面双坦先补重伤', scope: ['game:lol'], private: false, status: 'candidate', evidence: { games: 3, hits: 2, counter: 0 } },
    { id: 'b', kind: 'preference', claim: '喜欢激进开团' },
  ]);
  assert.equal(payload.rows.length, 2);
  assert.equal(payload.rows[0].status, 'candidate');
  assert.equal(payload.rows[1].status, 'candidate', 'old records without status default to candidate');
  assert.deepEqual(payload.rows[1].scope, []);
  assert.deepEqual(payload.rows[1].evidence, { games: 0, hits: 0, counter: 0 });
  assert.equal(typeof payload.rows[1].private, 'boolean');
});

test('a veto without an id is refused rather than reported as success', () => {
  assert.deepEqual(correctRequest({}), { ok: false, reason: 'missing-id' });
  assert.deepEqual(correctRequest({ id: '   ' }), { ok: false, reason: 'missing-id' });
  assert.equal(correctRequest({ id: 'xp-1', reason: '不对' }).id, 'xp-1');
  assert.equal(correctRequest({ id: 'xp-1', reason: 'x'.repeat(500) }).reason.length, 200, 'reasons are bounded');
});
