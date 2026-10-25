import test from 'node:test';
import assert from 'node:assert/strict';
import { screen, inspectScreen } from '../adapters/screen.mjs';
import { resolveAdapter } from '../adapters/index.mjs';
import { createGenericController } from '../controller.mjs';
import { createGenericRuntime } from '../runtime.mjs';
import { validateGeometry } from '../../game-observation/contracts.mjs';

const target = { kind: 'window', id: 'controlled-fixture', width: 640, height: 480, authorized: true };
const frame = { target_id: target.id, width: 640, height: 480, captured_at_ms: 10000,
  assistant_excluded: true, sha256: 'a'.repeat(64) };
const unread = () => ({ screen_kind: 'unknown', game_name: null, visual_status: 'unread', texts: [], entities: [] });

test('game identity retains separate evidence for mode and never accepts unsupported identity',()=>{
 const identity={game_mode:{value:'海克斯大乱斗',confidence:'medium',evidence:['模式标题：海克斯大乱斗']}};
 const value=screen.normalize({...unread(),visual_status:'partial',identity});
 assert.equal(value.identity.game_mode.value,'海克斯大乱斗');assert.equal(value.identity.game_name,undefined);
 assert.throws(()=>screen.normalize({...unread(),identity}),/unread_screen/);
 assert.throws(()=>screen.normalize({...unread(),visual_status:'partial',identity:{game_name:{value:'猜测',confidence:'high',evidence:[]}}}),/invalid_game_identity/);
});

for (const kind of ['board', 'cards', 'menu', 'results', 'other']) {
  test(`shared controller accepts ${kind} facts without registering a game-specific parser (structured fixture)`, async () => {
    let received;
    const controller = createGenericController({ enabled: true, wallNow: () => 10000,
      analyze: async input => { received = input; return '只依据本次已确认信息回答。'; } });
    const session = controller.start({ game: 'generic', target });
    const value = { screen_kind: kind, game_name: null, visual_status: 'partial', texts: ['已观察文本'],
      entities: [{ type: 'label', label: '已观察对象', source: 'local', box: { x: .1, y: .1, width: .2, height: .2 } }] };
    assert.equal(controller.ingest({ session_id: session.session_id, frame, state: value }).status, 'accepted');
    assert.equal((await controller.explain('解释已确认信息', { allowIncomplete: true })).status, 'completed');
    assert.equal(received.context.game, 'generic');
    assert.equal(received.context.current_match_state.state.screen_kind, kind);
    assert.equal(received.context.current_match_state.state.game_name, null);
    assert.ok(!('cells' in received.context.current_match_state.state));
    assert.equal(received.context.capabilities.rules_engine, false);
    controller.stop();
  });
}

test('capture inspection never guesses the game, creates a board or claims semantic recognition', () => {
  for (const color of [0, 100, 255]) {
    const result = inspectScreen({ width: 32, height: 20, rgb: new Uint8Array(32 * 20 * 3).fill(color) });
    assert.equal(result.status, 'unknown');
    assert.equal(result.reason, 'visual_reader_not_connected');
    assert.deepEqual(result.state, unread());
    assert.equal(screen.normalize(result.state).complete, false);
  }
  assert.throws(() => inspectScreen({ width: 32, height: 20, rgb: new Uint8Array(1) }), /invalid_screen_image/);
});

test('generic schema limits payload and coordinates and rejects semantic claims marked unread', () => {
  for (const value of [{ ...unread(), texts: ['unknown content'] }, { ...unread(), screen_kind: 'cards' },
    { ...unread(), visual_status: 'read', texts: ['x'.repeat(257)] },
    { ...unread(), visual_status: 'partial', entities: [{ type: 'card', label: 'x', source: 'cloud',
      box: { x: .9, y: 0, width: .2, height: .2 } }] }]) {
    assert.throws(() => screen.normalize(value), /invalid_screen|unread_screen/);
  }
  assert.equal(resolveAdapter('generic'), screen);
  assert.throws(() => resolveAdapter('lol'), /unsupported_generic_game/);
});

test('initial generic question may ask an agent to observe, but late replies still cannot cross target sessions', async () => {
  let session, received;
  const controller = createGenericController({ enabled: true, wallNow: () => 10000,
    analyze: async value => {
      received = value;
      controller.ingest({ session_id: session.session_id, frame, state: unread() });
      return '画面尚未读懂，不能判断牌面。';
    } });
  session = controller.start({ game: 'generic', target });
  const result = await controller.explain('看看画面', { allowIncomplete: true });
  assert.equal(received.context.current_match_state, null);
  assert.equal(result.status, 'completed');
  assert.equal(controller.status().snapshot.state.visual_status, 'unread');
  controller.stop();
});

test('switching a generic window clears all old facts and chat; a foreign observation cannot enter the new session', async () => {
  const controller = createGenericController({ enabled: true, wallNow: () => 10000, analyze: async () => '本局回答' });
  const first = controller.start({ game: 'generic', target });
  controller.ingest({ session_id: first.session_id, frame, state: { ...unread(), visual_status: 'partial', texts: ['旧游戏文本'] } });
  await controller.explain('旧问题', { allowIncomplete: true });
  const second = controller.start({ game: 'generic', target: { ...target, id: 'new-window' } });
  assert.notEqual(first.session_id, second.session_id);
  assert.equal(controller.status().snapshot, null);
  assert.equal(controller.ingest({ session_id: first.session_id, frame, state: unread() }).status, 'discarded');
  controller.stop();
});

test('runtime defaults to generic observation, not Gomoku, with no semantic claims or cloud calls', async () => {
  let cloud = 0;
  const runtime = createGenericRuntime({ enabled: true, specializedActive: async () => false,
    now: () => 10000, wallNow: () => 10000, analyze: async () => { cloud++; return 'reply'; },
    observer: { select: async () => target, clear() {},
      capture: async () => ({ frame, geometry: {}, image: { width: 32, height: 20, rgb: new Uint8Array(1920) } }) } });
  const session = await runtime.start({ targetId: target.id, authorized: true });
  assert.match(session.session_id, /^generic-generic-/);
  assert.equal((await runtime.observe()).recognition_status, 'unknown');
  assert.equal(runtime.state().game, 'generic');
  assert.equal(runtime.state().facts.visual_status, 'unread');
  assert.equal(runtime.state().capabilities.image_upload, false);
  assert.equal(cloud, 0);
  runtime.stop();
});

test('shared crop geometry preserves window-to-image coordinates and rejects foreign or out-of-window mappings', () => {
  const value = { pixel_roi: { x: 100, y: 50, width: 400, height: 300 },
    source_size: { width: 640, height: 480 }, output_size: { width: 640, height: 480 } };
  assert.deepEqual(validateGeometry(value, frame, target), value);
  assert.equal(validateGeometry(null, frame, target), null);
  for (const bad of [{ ...value, pixel_roi: { ...value.pixel_roi, x: 500 } },
    { ...value, source_size: { width: 1920, height: 1080 } },
    { ...value, output_size: { width: 320, height: 240 } }]) {
    assert.throws(() => validateGeometry(bad, frame, target), /invalid_observation_geometry/);
  }
});
