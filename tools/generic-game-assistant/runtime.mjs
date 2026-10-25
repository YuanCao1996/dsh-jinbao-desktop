import { createGenericController } from './controller.mjs';
import { createAdaptiveScheduler } from '../game-observation/adaptive.mjs';
import { createWindowObserver } from '../game-observation/windows.mjs';
import { recognizeGomokuPixels } from './adapters/gomoku/pixels.mjs';
import { gomoku } from './adapters/gomoku/index.mjs';
import { screen, inspectScreen } from './adapters/screen.mjs';
import { createObservationPolicy } from '../game-observation/policy.mjs';
import { createIdentityTracker } from './identity.mjs';
import { visualSignature, significantChange } from '../game-observation/visual-change.mjs';

export function createGenericRuntime({ enabled = false, observer, recognize,
  specializedActive, analyze, readImage, log = () => {}, now = () => performance.now(), wallNow = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, schedulerOptions = {} } = {}) {
  const windows = observer ?? createWindowObserver({ enabled });
  let engine = null;
  const identities=createIdentityTracker({now});
  let scheduler = null;
  let binding = null;
  let pending = null;
  let timer = null;
  let epoch = 0;
  let starting = 0;
  let automaticMode = false;
  let cached = null;
  let lastRecognition = null;
  let selectedGame = null;
  let cloudImagesAllowed = false, visionAbort = null, visionBudget = null, visualCache = null;
  function emit(event, data = {}) {
    try { log({ event, module: 'generic-game-assistant', time: new Date(wallNow()).toISOString(),
      session_id: binding?.session_id ?? null, ...data }); } catch {}
  }
  function clear() {
    identities.clear();
    epoch += 1;
    if (timer !== null) clearTimer(timer);
    timer = null;
    pending?.abort();
    pending = null;
    windows.clear();
    engine?.stop();
    engine = null;
    binding = null;
    cached = null;
    lastRecognition = null;
    selectedGame = null;
    cloudImagesAllowed = false;
    visionAbort?.abort(); visionAbort = null; visualCache = null;
    automaticMode = false;
  }
  async function checkSpecialized() {
    if (typeof specializedActive !== 'function') throw new Error('specialized_activity_not_checked');
    const active = await specializedActive();
    if (typeof active !== 'boolean') throw new Error('specialized_activity_not_checked');
    if (active) throw new Error('specialized_game_active');
  }
  async function observe({ manual = true, signal } = {}) {
    if (!enabled) return { status: 'disabled' };
    if (!binding) return { status: 'no_session' };
    if (pending) return { status: 'skipped', reason: 'observation_busy' };
    const owner = binding, expected = epoch;
    const abort = new AbortController();
    pending = abort;
    const cancel = () => abort.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) abort.abort();
    try {
      await checkSpecialized();
      if (abort.signal.aborted || expected !== epoch) return { status: 'discarded', reason: 'session_changed' };
      const admission = scheduler.admit({ active: true, manual });
      if (!admission.allowed) return { status: 'skipped', reason: admission.reason, retry_ms: admission.retry_ms };
      emit('capture_started');
      const start = now();
      const capture = await windows.capture(admission.request, { signal: abort.signal });
      await checkSpecialized();
      if (abort.signal.aborted || owner !== binding || expected !== epoch) return { status: 'discarded', reason: 'session_changed' };
      const previousSize = cached?.geometry?.source_size;
      const currentSize = capture.geometry?.source_size;
      if (previousSize && currentSize && (previousSize.width !== currentSize.width || previousSize.height !== currentSize.height)) {
        scheduler.resetPlan(); visualCache = null;
        cached = null; lastRecognition = null; engine.invalidate('window_resized');
        emit('observation_region_reset', {reason:'window_resized'});
        return {status:'discarded',reason:'window_resized'};
      }
      const fingerprint = JSON.stringify({ hash: capture.frame.sha256, geometry: capture.geometry });
      const pixelsChanged = cached?.fingerprint !== fingerprint;
      const signature=visualSignature(capture.image);
      const sameRegion=JSON.stringify(cached?.geometry)===JSON.stringify(capture.geometry);
      const schedulingChange=!cached || (sameRegion && significantChange(cached.signature,signature));
      const reader = recognize ?? (selectedGame === 'gomoku' ? recognizeGomokuPixels : inspectScreen);
      const recognized = cached?.fingerprint === fingerprint ? cached.recognition : reader(capture.image);
      if (!recognized || !['observed', 'unknown'].includes(recognized.status)) throw new Error('invalid_recognition_result');
      const state = selectedGame === 'generic' ? recognized.state : recognized.status === 'observed' ? recognized.state : {
        board_size: 15, cells: Array(225).fill('unknown'), turn: 'unknown', player_color: 'unknown', rules: 'unknown' };
      const normalized = (selectedGame === 'generic' ? screen : gomoku).normalize(state);
      const result = engine.ingest({ session_id: owner.session_id, frame: capture.frame, state: normalized,
        geometry: capture.geometry?.pixel_roi && capture.geometry?.source_size && capture.geometry?.output_size
          ? capture.geometry : undefined });
      if (result.status !== 'accepted') throw new Error(result.reason ?? 'observation_rejected');
      cached = { fingerprint, recognition: recognized, frame: capture.frame,geometry:capture.geometry,signature,
        ...(cloudImagesAllowed && capture.png?.length <= 32768 ? { png: capture.png } : {}) };
      lastRecognition = structuredClone(recognized);
      const ok = selectedGame === 'generic' || (recognized.status === 'observed' && !recognized.unknown_cells);
      scheduler.complete({ changed: selectedGame === 'generic' ? schedulingChange : result.changed, ok });
      if (!ok) scheduler.resetPlan();
      if (selectedGame === 'gomoku' && ok && !scheduler.status().plan && recognized.board && capture.geometry?.source_size) {
        const box = capture.geometry.pixel_roi, source = capture.geometry.source_size;
        const board = recognized.board;
        const sx = box.width / capture.image.width, sy = box.height / capture.image.height;
        const left = Math.max(0, box.x + (board.x[0] - board.spacing_x * 0.65) * sx);
        const top = Math.max(0, box.y + (board.y[0] - board.spacing_y * 0.65) * sy);
        const right = Math.min(source.width, box.x + (board.x.at(-1) + board.spacing_x * 0.65) * sx);
        const bottom = Math.min(source.height, box.y + (board.y.at(-1) + board.spacing_y * 0.65) * sy);
        scheduler.propose({ quality: 'standard', interval_ms: 1000, duration_ms: 30000,
          roi: { x: left / source.width, y: top / source.height,
            width: (right - left) / source.width, height: (bottom - top) / source.height } });
        emit('board_region_learned');
      }
      emit('capture_completed', { elapsed_ms: Math.round(now() - start), changed: result.changed,
        recognition_status: recognized.status, ...(selectedGame === 'gomoku' ? { unknown_cells: recognized.unknown_cells ?? 225 } : {}),
        frame_sha256: capture.frame.sha256, width: capture.frame.width, height: capture.frame.height });
      return { status: 'observed', changed: result.changed, recognition_status: recognized.status,
        state: stateForModel() };
    } catch (error) {
      if (owner !== binding || expected !== epoch || abort.signal.aborted) return { status: 'discarded', reason: 'session_changed' };
      engine.invalidate('observation_unavailable');
      cached = null;
      lastRecognition = null;
      scheduler.complete({ changed: false, ok: false });
      const reason = /^[a-z_]+$/.test(error.message) ? error.message : 'observation_failed';
      if(reason==='target_geometry_changed'){scheduler.resetPlan();visualCache=null;}
      emit('capture_failed', { reason });
      return { status: 'unavailable', reason };
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (pending === abort) pending = null;
    }
  }
  function stateForModel() {
    const status = engine?.status();
    const snapshot = status?.snapshot;
    const age = snapshot ? wallNow() - snapshot.frame.captured_at_ms : null;
    return { session_id: binding?.session_id ?? null, game: selectedGame,
      identity:identities.snapshot(),
      revision: status?.revision ?? 0, status: snapshot && age >= 0 && age <= 5000 ? 'observed' : 'unknown',
      captured_at_ms: snapshot?.frame.captured_at_ms ?? null, age_ms: age,
      geometry: snapshot ? structuredClone(snapshot.geometry ?? null) : null,
      facts: snapshot && age >= 0 && age <= 5000 ? structuredClone(snapshot.state) : null,
      recognition_status: lastRecognition?.status ?? 'unknown',
      capabilities: { rules_engine: false, automatic_input: false, image_upload: cloudImagesAllowed,
        visual_reader: cloudImagesAllowed && typeof readImage === 'function' } };
  }
  async function loop(expected) {
    timer = null;
    if (expected !== epoch || !binding) return;
    const result = await observe({ manual: false });
    if (expected !== epoch || !binding) return;
    timer = setTimer(() => { void loop(expected); }, Math.max(1000, result.retry_ms ?? 1000));
    timer?.unref?.();
  }
  return {
    async start({ targetId, authorized, automatic = false, game = 'generic', allowCloudImages = false } = {}) {
      if (!enabled) return { status: 'disabled' };
      if (authorized !== true) throw new Error('authorized_window_required');
      if (typeof automatic !== 'boolean') throw new Error('invalid_observation_mode');
      if (typeof allowCloudImages !== 'boolean') throw new Error('invalid_image_permission');
      if (!['generic', 'gomoku'].includes(game)) throw new Error('unsupported_generic_game');
      if (game !== 'generic' && allowCloudImages) throw new Error('image_permission_not_available');
      const operation = ++starting;
      await checkSpecialized();
      if (operation !== starting) throw new Error('session_changed');
      clear();
      const expected = epoch;
      let target;
      try {
        target = await windows.select({ id: targetId, authorized });
        await checkSpecialized();
        if (operation !== starting || expected !== epoch) throw new Error('session_changed');
      } catch (error) {
        if (expected === epoch) clear();
        throw error;
      }
      scheduler = createAdaptiveScheduler({ ...schedulerOptions, now });
      engine = createGenericController({ enabled: true, analyze: typeof analyze !== 'function' ? undefined : async value => {
        const reply = await analyze({ ...value, context: { ...value.context, capabilities: {
          ...value.context.capabilities, image_upload: cloudImagesAllowed,
          visual_reader: cloudImagesAllowed && typeof readImage === 'function' } } });
        if (selectedGame === 'generic' && stateForModel().age_ms > 5000 && !value.signal.aborted)
          await observe({ manual: true, signal: value.signal });
        return reply;
      }, log, now, wallNow, analysisTimeoutMs: 60000 });
      binding = engine.start({ game, target });
      selectedGame = game;
      cloudImagesAllowed = allowCloudImages;
      visionBudget = createObservationPolicy({ now, maxCloudCalls: 10 });
      automaticMode = automatic;
      emit('runtime_started', { automatic, game });
      if (automatic) timer = setTimer(() => { void loop(expected); }, 0);
      return { ...binding };
    },
    stop() { starting += 1; emit('runtime_stopped'); clear(); },
    observe,
    setImagePermission(allowed) {
      if (typeof allowed !== 'boolean') throw new Error('invalid_image_permission');
      if (!binding) throw new Error('no_session');
      if (allowed && selectedGame !== 'generic') throw new Error('image_permission_not_available');
      cloudImagesAllowed = allowed;
      visionAbort?.abort(); visualCache = null; cached = null;
      emit('image_permission_changed', { allowed });
      return { allowed };
    },
    async readScreen({ signal, admitObservation = () => {}, focus = '' } = {}) {
      if (typeof focus !== 'string' || focus.length > 200) throw new Error('invalid_visual_focus');
      if (!binding || selectedGame !== 'generic') throw new Error('generic_visual_session_required');
      if (!cloudImagesAllowed) throw new Error('image_upload_not_authorized');
      if (typeof readImage !== 'function') throw new Error('visual_reader_not_connected');
      if (visionAbort) throw new Error('visual_read_busy');
      const owner = binding, expected = epoch;
      const abort = new AbortController(); visionAbort = abort;
      const cancel = () => abort.abort(); signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) abort.abort();
      try {
        await checkSpecialized(); abort.signal.throwIfAborted();
        if (!cached || stateForModel().age_ms > 5000) { admitObservation(); await observe({ manual: true, signal: abort.signal }); }
        if (owner !== binding || expected !== epoch) throw new Error('visual_context_changed');
        if (stateForModel().status !== 'observed') throw new Error('observation_stale');
        const captured = cached;
        if (!captured) throw new Error('observation_unavailable');
        if (!captured.png) {
          emit('visual_input_rejected', {reason:'image_budget_exceeded',width:captured.frame.width,height:captured.frame.height,limit_bytes:32768});
          throw new Error('image_budget_exceeded');
        }
        const hash = captured.frame.sha256;
        if (visualCache?.fingerprint === captured.fingerprint && visualCache.focus === focus)
          return { status: 'read', cached: true, state: stateForModel() };
        const admission = visionBudget.cloud({ positionHash: hash, reason: 'user_question' });
        if (!admission.allowed) throw new Error(admission.reason);
        emit('visual_read_started', { frame_sha256: hash, image_bytes: captured.png.length });
        const facts = await readImage({ png: captured.png, frame: captured.frame,
          geometry: engine.status().snapshot?.geometry ?? null, signal: abort.signal, focus });
        await checkSpecialized(); abort.signal.throwIfAborted();
        if (stateForModel().age_ms > 5000) { admitObservation(); await observe({ manual: true, signal: abort.signal }); }
        if (owner !== binding || expected !== epoch || cached?.fingerprint !== captured.fingerprint) throw new Error('visual_context_changed');
        const committed = engine.enrich({ session_id: owner.session_id, frame_sha256: hash, state: facts });
        if (committed.status !== 'accepted') throw new Error(committed.reason);
        cached.recognition = { status: 'observed', state: facts };
        lastRecognition = cached.recognition;
        const readable = facts.visual_status !== 'unread' && (facts.texts.length || facts.entities.length || Object.keys(facts.identity ?? {}).length);
        identities.observe(facts.identity,hash);
        scheduler.feedback({readable:!!readable});
        visualCache = readable ? { fingerprint: captured.fingerprint, focus } : null;
        emit('visual_read_completed', { frame_sha256: hash, texts: facts.texts.length, entities: facts.entities.length });
        return { status: readable ? 'read' : 'unread', cached: false, state: stateForModel() };
      } catch (error) {
        emit('visual_read_failed', { reason: /^[a-z0-9_]+$/.test(error.message) ? error.message : 'visual_read_failed' });
        throw error;
      } finally { signal?.removeEventListener('abort', cancel); if (visionAbort === abort) visionAbort = null; }
    },
    state: stateForModel,
    plan(value) {
      if (!binding) throw new Error('no_session');
      const status = scheduler.propose(value);
      emit('observation_plan_updated', { plan: status.plan });
      return status;
    },
    async ask(question) {
      if (!engine) return { status: enabled ? 'no_session' : 'disabled' };
      await checkSpecialized();
      return engine.explain(question, { allowIncomplete: true });
    },
    status() { return { enabled, session_id: binding?.session_id ?? null, observing: pending !== null,
      identity:identities.snapshot(),
      automatic: automaticMode, scheduling: timer !== null, scheduler: binding ? scheduler.status() : null,
      vision_budget: binding ? visionBudget.status() : null }; },
  };
}
