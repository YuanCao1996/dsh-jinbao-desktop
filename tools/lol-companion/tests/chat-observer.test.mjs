import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatObserver} from '../chat-observer.mjs';
import {applyOverlayEvent, initialOverlayState} from '../../dsh-onboarding/overlay-state.mjs';

// Real match 2026-11-03: the client listed only 2 of the 3 augments the player actually
// took. Windows OCR had split the announcement into pieces, the verb test then ran on the
// joined string, every chat record came out confidence:'low', and progress-events.mjs
// deliberately ignores low-confidence records — so the first augment was dropped from
// 本局已选 and every later piece of advice assumed the wrong build.
//
// These pin the parse, the confidence and the owned-augment projection together.

const NAMES = ['急速之追求', '台风', '双发快射'];
const poly = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const catalog = { champions: [{ name: '虚空女皇', alias: 'Belveth' }, { name: '时间刺客', alias: 'Ekko' }], items: [] };
const meState = { gameSeconds: 195, me: { champion: '虚空女皇', championAlias: 'Belveth' }, allies: [], enemies: [] };

function observe(lines) {
  const events = [];
  const observer = createChatObserver(NAMES, (event) => events.push(event));
  observer.setCatalog(catalog);
  observer.observe({ available: true, foreground: true, width: 1920, height: 1080, lines }, meState);
  return events;
}

test('a plain augment announcement is high confidence and owned by the player', () => {
  const events = observe([{ box: poly(20, 700, 320, 22), text: '虚空女皇 已质变了 急速之追求' }]);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'augment_mutate');
  assert.equal(events[0].augment, '急速之追求');
  assert.equal(events[0].confidence, 'high');
  assert.equal(events[0].who, 'self');
});

test('a verb split across two OCR boxes still counts as a told record', () => {
  const events = observe([
    { box: poly(20, 700, 150, 22), text: '虚空女皇 已质变' },
    { box: poly(175, 700, 180, 22), text: '了 急速之追求' },
  ]);
  assert.equal(events.length, 1, 'the two fragments must collapse into one record');
  assert.equal(events[0].augment, '急速之追求');
  assert.equal(events[0].confidence, 'high');
  assert.equal(events[0].who, 'self');
});

test('a verb split across three boxes keeps the last augment and the owner', () => {
  const events = observe([
    { box: poly(20, 700, 110, 22), text: '虚空女皇 已' },
    { box: poly(135, 700, 70, 22), text: '质变 了' },
    { box: poly(210, 700, 140, 22), text: '台风' },
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].augment, '台风');
  assert.equal(events[0].confidence, 'high');
  assert.equal(events[0].who, 'self');
});

test('another player\'s split announcement stays attributed to them', () => {
  const events = observe([
    { box: poly(20, 700, 160, 22), text: '时间刺客 已质变' },
    { box: poly(185, 700, 160, 22), text: '了 急速之追求' },
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].augment, '急速之追求');
  assert.equal(events[0].who, 'other');
  assert.equal(events[0].confidence, 'high');
});

test('fragments a few pixels apart are the same line', () => {
  const events = observe([
    { box: poly(20, 700, 160, 22), text: '虚空女皇 已质变' },
    { box: poly(20, 708, 160, 22), text: '了 急速之追求' },
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].who, 'self');
  assert.equal(events[0].confidence, 'high');
});

test('a bare augment mention without the verb is never treated as told', () => {
  const events = observe([{ box: poly(20, 700, 320, 22), text: '虚空女皇 急速之追求' }]);
  assert.equal(events.length, 1);
  assert.equal(events[0].confidence, 'low', 'no verb means the record may not own the augment');
});

test('a told chat record reaches the owned list; an untold one does not', () => {
  const told = observe([
    { box: poly(20, 700, 150, 22), text: '虚空女皇 已质变' },
    { box: poly(175, 700, 180, 22), text: '了 急速之追求' },
  ])[0];
  const untold = observe([{ box: poly(20, 720, 320, 22), text: '虚空女皇 台风' }])[0];

  const state = initialOverlayState();
  state.game = 'lol';
  state.match = 'one#1';
  state.me = { champion: '虚空女皇' };
  for (const event of [told, untold]) {
    applyOverlayEvent(state, { ...event, game: 'lol', match: 'one#1', t: Date.now() }, 'lol-live.jsonl');
  }
  assert.ok(state.ownedAugments.includes('急速之追求'), 'a told record must be owned: ' + JSON.stringify(state.ownedAugments));
  assert.ok(!state.ownedAugments.includes('台风'), 'an untold mention must not be owned: ' + JSON.stringify(state.ownedAugments));
});
