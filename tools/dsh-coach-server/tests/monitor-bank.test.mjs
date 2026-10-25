import test from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorBank } from '../lib/monitor-bank.js';

test('each match owns its monitor; a new match closes the previous Agent without touching the other game', () => {
  const monitors = [];
  const bank = createMonitorBank((game, source) => {
    const monitor = { game, source, running: false, closed: false,
      health() { return { running: this.running, queued: 0 }; },
      isReady: () => true, clearQueue() {}, push() {}, close() { this.closed = true; } };
    monitors.push(monitor); return monitor;
  }, 2);
  const lol = bank.get('lol', 'match1');
  lol.running = true;
  const wzry = bank.get('wzry', 'match1');
  assert.notEqual(lol, wzry);
  assert.equal(bank.get('lol', 'match1'), lol);
  const next = bank.get('lol', 'match2');
  assert.notEqual(next, lol); assert.equal(wzry.closed, false); assert.equal(lol.closed, true);
  next.running = true;
  const nextWzry=bank.get('wzry', 'match2');assert.equal(wzry.closed,true);assert.notEqual(nextWzry,wzry);
  bank.close(); assert.equal(lol.closed, true); assert.equal(next.closed, true);
});
