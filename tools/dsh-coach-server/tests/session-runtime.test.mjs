import test from 'node:test';
import assert from 'node:assert/strict';
import { openCoachSession } from '../lib/session-runtime.js';

test('first use creates a session; persisted identity uses the DSH resume API', async () => {
  let stored;
  const calls = [];
  const ctx = { get: () => ({ stat: async id => { calls.push(['stat',id]);return stored; } }), agentLoop: {
    createAgent: async (_ctx, options) => { calls.push(['create',options]); return { agent: {} }; },
    resume: async (_ctx, options) => { calls.push(['resume',options]); return { agent: {} }; },
  } };
  const setup = () => {}, signal = new AbortController().signal;
  await openCoachSession(ctx,{sessionId:'coach-test',meta:{cwd:'workspace'},agentOptions:{model:'model'},setup,signal});
  assert.equal(calls[1][0],'create');assert.equal(calls[1][1].sessionId,'coach-test');
  stored={header:{id:'coach-test'}};
  await openCoachSession(ctx,{sessionId:'coach-test',meta:{cwd:'other'},agentOptions:{model:'model'},setup,signal});
  assert.equal(calls[3][0],'resume');
  assert.equal(calls[3][1].resumeSessionId,'coach-test');
  assert.equal(calls[3][1].meta,undefined);
  assert.equal(calls[3][1].setup,setup);assert.equal(calls[3][1].signal,signal);
});

test('storage read failure remains visible rather than replacing existing history', async () => {
  let creates = 0;
  const ctx = { get: () => ({stat:async()=>{throw Error('storage unavailable');}}),
    agentLoop:{createAgent:()=>{creates++;}} };
  await assert.rejects(openCoachSession(ctx,{sessionId:'coach-test'}),/storage unavailable/);
  assert.equal(creates,0);
});
