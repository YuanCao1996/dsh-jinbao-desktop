import test from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_WINDOW, projectEvent, eventWindow } from '../lib/event-window.mjs';

const make = (count, text = '事件') => Array.from({ length: count }, (_, i) => ({
  key: 'k' + i, time: '0' + (i % 10) + ':00', text: `${text}${i}`, kind: i % 2 ? 'purchase' : 'augment_picked',
}));

test('the projected event keeps its kind so the Agent can classify it without querying', () => {
  const row = projectEvent({ time: '01:05', text: '安妮购买装备：残疫', kind: 'purchase' });
  assert.deepEqual(row, { time: '01:05', text: '安妮购买装备：残疫', kind: 'purchase' });
});

test('projection clips text, flattens newlines and drops empty rows', () => {
  const row = projectEvent({ time: '02:00', text: '第一行\n第二行   ' + 'x'.repeat(400), kind: 'inventory' });
  assert.equal(row.text.length, EVENT_WINDOW.textChars);
  assert.ok(!row.text.includes('\n'));
  assert.equal(projectEvent({ time: '02:00', text: '   ' }), null);
  assert.equal(projectEvent(null), null);
});

test('the window keeps the newest events and reports how many were held back', () => {
  const { rows, heldBack } = eventWindow(make(35));
  assert.equal(rows.length, EVENT_WINDOW.count);
  assert.equal(heldBack, 35 - EVENT_WINDOW.count);
  // Newest-first retention: the last stored event must be present, the first must not.
  assert.equal(rows.at(-1).text, '事件34');
  assert.ok(!rows.some(row => row.text === '事件0'));
});

test('a short stream is passed through without a held-back count', () => {
  const { rows, heldBack } = eventWindow(make(3));
  assert.equal(rows.length, 3);
  assert.equal(heldBack, 0);
});

test('the byte budget drops the oldest rows first and counts them as held back', () => {
  const big = Array.from({ length: 20 }, (_, i) => ({ time: '01:00', text: `${i}-` + '宽'.repeat(240), kind: 'purchase' }));
  const { rows, heldBack } = eventWindow(big, { count: 20, totalBytes: 1200 });
  assert.ok(rows.length > 0 && rows.length < 20);
  assert.ok(Buffer.byteLength(JSON.stringify(rows)) <= 1200);
  assert.equal(rows.at(-1).text.slice(0, 3), '19-');
  assert.equal(heldBack, 20 - rows.length);
});

test('every consumer reads the same window constants', () => {
  // Guard against the two lines drifting apart again: these numbers are the contract.
  assert.equal(EVENT_WINDOW.count, 20);
  assert.equal(EVENT_WINDOW.textChars, 240);
  assert.equal(EVENT_WINDOW.totalBytes, 16000);
});
