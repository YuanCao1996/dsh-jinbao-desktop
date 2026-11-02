import test from 'node:test';
import assert from 'node:assert/strict';
import { initialOverlayState, overlayView } from '../overlay-state.mjs';
import { createAdviceValidity } from '../../dsh-coach-server/lib/lol-coaching-plan.js';

// overlayView compares against the real clock, so the fixture must live near "now".
const NOW = Date.now();

function liveState(overrides = {}) {
  const state = initialOverlayState();
  Object.assign(state, {
    game: 'lol', match: 'm', matchStartedAt: 1, at: NOW, gameSeconds: 120, phase: 'InProgress',
    me: { champion: '安妮', level: 8, items: [{ name: '残疫', completed: true }] },
    allies: [], enemies: [],
  }, overrides);
  return state;
}

test('advice that only went stale stays visible with a marker instead of a status label', () => {
  const state = liveState();
  // Validity is built against the current context, then the context moves on.
  const validity = createAdviceValidity('situation', state, NOW);
  state.me.items = [{ name: '残疫', completed: true }, { name: '灭世者的死亡之帽', completed: true }];
  state.broadcasts = [{ text: '先补中娅沙漏再出死亡之帽', at: NOW, validity, expiresAt: NOW - 1 }];

  const advice = overlayView(state).advice;
  assert.match(advice, /先补中娅沙漏再出死亡之帽/);
  assert.match(advice, /稍早建议，局势已变化/);
});

test('a still-valid broadcast is shown without the stale marker', () => {
  const state = liveState();
  const validity = createAdviceValidity('situation', state, NOW);
  state.broadcasts = [{ text: '先清线再回城', at: NOW, validity }];

  const advice = overlayView(state).advice;
  assert.match(advice, /先清线再回城/);
  assert.doesNotMatch(advice, /稍早建议/);
});

test('an expired short-lived reminder is never shown as stale advice', () => {
  const state = liveState({ allies: [{ champion: '金克丝', championAlias: 'Jinx' }] });
  // Ally-ultimate reminders carry a four-second expiry; they assert a fact that stops
  // being true, so they must disappear rather than resurface with a staleness marker.
  state.broadcasts = [{ text: '金克丝大招可用', at: NOW, allyUltimate: 'Jinx', validity: null, expiresAt: NOW - 1 }];
  assert.doesNotMatch(overlayView(state).advice, /金克丝大招可用/);
});

test('an explicitly revoked reminder disappears even while it is still fresh', () => {
  const state = liveState({ allies: [{ champion: '金克丝', championAlias: 'Jinx' }] });
  state.broadcasts = [{ text: '金克丝大招可用', at: NOW, allyUltimate: 'Jinx', validity: null, expiresAt: NOW + 4000, revoked: true }];
  assert.doesNotMatch(overlayView(state).advice, /金克丝大招可用/);
});

test('a very old revoked broadcast is not resurrected', () => {
  const state = liveState();
  const validity = createAdviceValidity('situation', state, NOW);
  state.me.items = [{ name: '灭世者的死亡之帽', completed: true }];
  // Older than the five-minute grace window.
  state.broadcasts = [{ text: '十分钟前的旧建议', at: NOW - 600000, validity, expiresAt: NOW - 600000 }];
  assert.doesNotMatch(overlayView(state).advice, /十分钟前的旧建议/);
});
