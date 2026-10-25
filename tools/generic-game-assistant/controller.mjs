import { randomUUID } from 'node:crypto';
import { validateTarget, validateFrame, validateGeometry, planObservation } from '../game-observation/contracts.mjs';
import { createObservationPolicy } from '../game-observation/policy.mjs';
import { resolveAdapter } from './adapters/index.mjs';
import { buildContext, GENERIC_SYSTEM_PROMPT } from './context.mjs';

export function createGenericController({ enabled = false, analyze, log = () => {},
  wallNow = Date.now, now, policyOptions = {}, analysisTimeoutMs = 15000 } = {}) {
  if (!Number.isSafeInteger(analysisTimeoutMs) || analysisTimeoutMs < 1 || analysisTimeoutMs > 60000) {
    throw new Error('invalid_analysis_timeout');
  }
  let current = null;
  let pending = null;
  function emit(event, detail = {}) {
    try { log({ time: new Date(wallNow()).toISOString(), event,
      module: 'generic-game-assistant', session_id: current?.id ?? null, ...detail }); } catch {}
  }
  function cancel() { pending?.abort.abort(); }
  return {
    start({ game, target }) {
      if (!enabled) return { status: 'disabled' };
      const adapter = resolveAdapter(game);
      const window = validateTarget(target);
      cancel();
      current = { id: `generic-${game}-${randomUUID()}`, adapter, target: window,
        revision: 0, snapshot: null, history: [],
        policy: createObservationPolicy({ ...policyOptions, ...(now ? { now } : {}) }) };
      emit('session_started', { game, target_id: window.id });
      return { status: 'started', session_id: current.id };
    },
    stop() {
      cancel();
      emit('session_stopped');
      current = null;
    },
    observationPlan({ visible, foreground, ...request } = {}) {
      if (!current) return { status: enabled ? 'no_session' : 'disabled' };
      const plan = planObservation(current.target, request);
      const admission = current.policy.capture({ enabled, visible, foreground, intervalMs: plan.min_interval_ms });
      if (!admission.allowed) return { status: 'skipped', reason: admission.reason };
      return { status: 'ready', session_id: current.id, ...plan };
    },
    ingest({ session_id: sessionId, frame, state, geometry }) {
      if (!current || sessionId !== current.id) return { status: 'discarded', reason: 'session_changed' };
      try {
        const image = validateFrame(frame, current.target, wallNow());
        const mapping = validateGeometry(geometry, image, current.target);
        if (current.snapshot && image.captured_at_ms <= current.snapshot.frame.captured_at_ms) {
          return { status: 'discarded', reason: 'observation_out_of_order' };
        }
        const position = current.adapter.normalize(state);
        const changed = current.snapshot?.state.position_hash !== position.position_hash;
        if (changed) {
          current.revision += 1;
          // The first generic observation supplies previously unknown evidence to an active tool request.
          if (current.adapter.id === 'generic' && !current.snapshot && pending) pending.revision = current.revision;
          else cancel();
        }
        current.snapshot = { frame: image, state: position, ...(mapping ? { geometry: mapping } : {}) };
        emit('observation_accepted', { revision: current.revision, changed,
          complete: position.complete, captured_at_ms: image.captured_at_ms,
          frame_sha256: image.sha256, position_hash: position.position_hash });
        return { status: 'accepted', revision: current.revision, changed, complete: position.complete };
      } catch (error) {
        // An invalid newer observation must not leave the old board usable as current.
        current.snapshot = null;
        current.revision += 1;
        cancel();
        emit('observation_rejected', { reason: error.message });
        return { status: 'rejected', reason: error.message };
      }
    },
    invalidate(reason = 'observation_unavailable') {
      if (!current) return;
      current.snapshot = null;
      current.revision += 1;
      cancel();
      emit('observation_invalidated', { reason });
    },
    enrich({ session_id: id, frame_sha256: hash, state }) {
      if (!current || current.id !== id || current.adapter.id !== 'generic' || current.snapshot?.frame.sha256 !== hash)
        return { status: 'discarded', reason: 'visual_context_changed' };
      const age = wallNow()-current.snapshot.frame.captured_at_ms;
      if (age < 0 || age > 5000) return { status: 'discarded', reason: 'visual_context_stale' };
      const normalized = current.adapter.normalize(state);
      if (normalized.position_hash !== current.snapshot.state.position_hash) current.revision++;
      current.snapshot.state = normalized;
      // This evidence is returned by a tool requested in the active turn, rather than unsolicited external facts.
      if (pending) pending.revision = current.revision;
      emit('visual_evidence_accepted', { frame_sha256: hash, revision: current.revision });
      return { status: 'accepted' };
    },
    async explain(question = '', { allowIncomplete = false } = {}) {
      if (!current) return { status: enabled ? 'no_session' : 'disabled' };
      if (typeof question !== 'string' || question.length > 2000) throw new Error('invalid_question');
      if (pending) return { status: 'skipped', reason: 'analysis_busy' };
      if (typeof analyze !== 'function') return { status: 'unavailable', reason: 'analysis_not_connected' };
      const owner = current;
      const snapshot = owner.snapshot;
      const generic = owner.adapter.id === 'generic';
      if ((!snapshot && !generic) || (snapshot && !allowIncomplete && !snapshot.state.complete))
        return { status: 'skipped', reason: 'observation_incomplete' };
      const age = snapshot ? wallNow() - snapshot.frame.captured_at_ms : null;
      if (snapshot && (age < 0 || age > 5000)) return { status: 'skipped', reason: 'observation_stale' };
      if (!question.trim()) return { status: 'skipped', reason: 'user_question_required' };
      const admission = owner.policy.cloud({ positionHash: snapshot?.state.position_hash ?? '0'.repeat(64), reason: 'user_question' });
      if (!admission.allowed) return { status: 'skipped', reason: admission.reason };
      const token = { abort: new AbortController(), revision: owner.revision };
      pending = token;
      const context = buildContext({ sessionId: owner.id, game: owner.adapter.id,
        revision: owner.revision, snapshot, question, history: owner.history });
      emit('analysis_started', { revision: token.revision, model_call: owner.policy.status().cloud_calls });
      let timeout;
      try {
        const cancelled = new Promise((_, reject) => {
          token.abort.signal.addEventListener('abort', () => reject(new Error('analysis_cancelled')), { once: true });
        });
        const expired = new Promise((_, reject) => {
          timeout = setTimeout(() => {
            reject(new Error('analysis_timeout'));
            token.abort.abort();
          }, analysisTimeoutMs);
        });
        const reply = await Promise.race([
          Promise.resolve().then(() => {
            if (token.abort.signal.aborted) throw new Error('analysis_cancelled');
            return analyze({ system: GENERIC_SYSTEM_PROMPT, context, signal: token.abort.signal });
          }),
          cancelled, expired,
        ]);
        const latestAge = wallNow() - (owner.snapshot?.frame.captured_at_ms ?? 0);
        if (current !== owner || owner.revision !== token.revision || token.abort.signal.aborted
            || (!(generic && !owner.snapshot) && (latestAge < 0 || latestAge > 5000))) {
          emit('analysis_discarded', { reason: 'context_changed_or_stale', request_session_id: owner.id });
          return { status: 'discarded', reason: 'context_changed_or_stale' };
        }
        if (typeof reply !== 'string' || !reply.trim()) throw new Error('empty_analysis_reply');
        if ([...reply.trim()].length > 256) throw new Error('analysis_reply_too_long');
        const text = reply.trim();
        owner.history.push({ role: 'user', content: question }, { role: 'assistant', content: text });
        if (owner.history.length > 20) owner.history.splice(0, owner.history.length - 20);
        emit('analysis_completed', { revision: token.revision, reply_chars: [...text].length });
        return { status: 'completed', text, session_id: owner.id, revision: token.revision };
      } catch (error) {
        if (error.message === 'analysis_timeout') {
          emit('analysis_failed', { reason: error.message });
          return { status: 'failed', reason: error.message };
        }
        if (token.abort.signal.aborted) {
          emit('analysis_discarded', { reason: 'context_changed_or_stale', request_session_id: owner.id });
          return { status: 'discarded', reason: 'context_changed_or_stale' };
        }
        emit('analysis_failed', { reason: error.message });
        return { status: 'failed', reason: error.message };
      } finally {
        clearTimeout(timeout);
        if (pending === token) pending = null;
      }
    },
    status() {
      return { enabled, session_id: current?.id ?? null, game: current?.adapter.id ?? null,
        revision: current?.revision ?? 0, snapshot: structuredClone(current?.snapshot ?? null),
        busy: pending !== null, budget: current?.policy.status() ?? null };
    },
  };
}
