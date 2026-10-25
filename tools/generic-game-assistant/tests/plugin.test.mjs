import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../plugin.mjs';

test('disabled plugin does not install services, tools, timers, or model connections', () => {
  const blocked = new Proxy({}, { get() { throw new Error('disabled_plugin_touched_host'); } });
  apply(blocked, {});
  apply(blocked, { enabled: false });
});

test('enabled plugin adds only its own human-facing service; fails closed without activity checker', async () => {
  const services = new Map();
  let cleanup;
  const ctx = { provide: (name, value) => services.set(name, value), effect: factory => { cleanup = factory(); },
    get: key => services.get(key), emit() {}, tools: { register() { throw new Error('global_tool_registration_forbidden'); } } };
  apply(ctx, { enabled: true, provider: 'fixture', model: 'fixture', sessionCwd: 'workspace/generic-game' });
  assert.deepEqual([...services.keys()], ['genericGame']);
  const game = services.get('genericGame');
  assert.equal(game.status().session_id, null);
  await assert.rejects(game.start({ authorized: true, targetId: 'fixture' }), /specialized_activity_not_checked/);
  await cleanup();
});
