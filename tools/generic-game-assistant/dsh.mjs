import { randomUUID } from 'node:crypto';
import { openCoachSession } from '../dsh-coach-server/lib/session-runtime.js';
import { registerGenericTools } from './dsh-tools.mjs';
import { assertSdkSingleton } from './sdk-check.mjs';
import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm';

export function createDshAnalyzer(ctx, { enabled = false, runtime: getRuntime, provider, model, cwd,
  timeoutMs = 55000, progress = () => {}, openSession = openCoachSession } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 55000) throw new Error('invalid_dsh_timeout');
  let owned = null;
  let ready = null;
  let pending = null;
  let sessionId = null;
  let epoch = 0;
  let busy = false;
  let lifetime = null;
  let busyAbort = null;
  function runtime() { return typeof getRuntime === 'function' ? getRuntime() : getRuntime; }
  async function close() {
    busyAbort?.abort();
    epoch += 1;
    const old = owned;
    owned = null;
    ready = null;
    sessionId = null;
    lifetime?.abort();
    lifetime = null;
    pending?.reject(new Error('dsh_session_closed'));
    pending = null;
    try { await old?.agent?.cancel?.(new Error('generic_session_closed'), { keepInbox: false }); } catch {}
    await old?.dispose?.();
  }
  async function ensure(id, signal) {
    if (id !== sessionId) {
      await close();
      if (signal.aborted) throw new Error('dsh_cancelled');
      sessionId = id;
      const expected = epoch;
      lifetime = new AbortController();
      let replied = false;
      ready = openSession(ctx, { sessionId: id, signal: lifetime.signal, meta: { cwd },
        agentOptions: { provider, model, maxTokens: 2048 }, setup: async agentCtx => {
          registerGenericTools(agentCtx, { runtime: runtime(), sessionId: id, request: () => pending,
            progress: event => { if (event.tool === 'generic_reply' && event.phase === 'completed') replied = true; progress(event); } });
          agentCtx.on('agent/pre-step', (payload, next) => {
            if (payload?.step === 1) replied = false;
            const fresh = payload?.messages?.some(message => message.source?.kind === 'user');
            if (replied && !fresh) return { kind: 'reject' };
            if (!pending || pending.finished || pending.signal.aborted || ++pending.steps > 12) return { kind: 'reject' };
            pending.turn = payload.turn;
            pending.naturalReply = null;
            pending.started = true;
            return next();
          });
          agentCtx.on('session/event', (session, event) => {
            if (!pending?.started || pending.finished || pending.signal.aborted || session.id !== id
                || event?.type !== 'assistant/message' || event.data?.turn !== pending.turn) return;
            const data = event.data;
            const finish = lastAssistantStreamChunk(data.stream ?? [], 'finish');
            const blocks = data.message?.content ?? [];
            if (data.interrupted || finish?.reason?.kind !== 'stop'
                || blocks.some(block => block.type === 'tool-call')) return;
            const text = blocks.filter(block => block.type === 'text' && typeof block.text === 'string')
              .map(block => block.text).join('').trim();
            if (text && [...text].length <= 256) pending.naturalReply = text;
          });
          agentCtx.on('agent/status', event => {
            if (event.status !== 'idle' || !pending?.started || pending.finished) return;
            if (pending.naturalReply && !pending.signal.aborted && runtime().status().session_id === id) {
              pending.finished = true;
              pending.resolve(pending.naturalReply);
            } else pending.reject(new Error('dsh_final_reply_missing'));
          });
          agentCtx.on('agent/request-error', (event, next) => {
            const code = String(event.failure?.code ?? 'unknown');
            if (pending && !pending.finished) pending.reject(new Error('dsh_provider_'
              + (/^[A-Z_]+$/.test(code) ? code.toLowerCase() : 'unknown')));
            return next();
          });
        } });
      ready.then(async value => {
        if (expected !== epoch) { await value?.dispose?.(); return; }
        owned = value;
      }).catch(() => {});
    }
    return ready;
  }
  return {
    async analyze({ system, context, signal }) {
      if (!enabled) throw new Error('dsh_disabled');
      if (!provider || !model || !cwd || !runtime()) throw new Error('dsh_configuration_missing');
      if (busy) throw new Error('dsh_busy');
      if (!context || !['generic', 'gomoku'].includes(context.game)
          || !new RegExp(`^generic-${context.game}-[a-f0-9-]{36}$`).test(context.session_id)
          || runtime().status().session_id !== context.session_id) throw new Error('dsh_game_scope_denied');
      if (signal?.aborted) throw new Error('dsh_cancelled');
      assertSdkSingleton();
      busy = true;
      const abort = new AbortController();
      const cancel = () => abort.abort();
      signal?.addEventListener('abort', cancel, { once: true });
      let timer;
      let request;
      try {
        const result = new Promise((resolve, reject) => {
          request = { resolve, reject, signal: abort.signal, steps: 0, toolCalls: 0, observations: 0, finished: false };
          abort.signal.addEventListener('abort', () => reject(new Error('dsh_cancelled')), { once: true });
          timer = setTimeout(() => { reject(new Error('dsh_timeout')); abort.abort(); }, timeoutMs);
        });
        // Attach rejection handling before asynchronous session setup can time out.
        result.catch(() => {});
        const opened = ensure(context.session_id, abort.signal);
        busyAbort = abort;
        await Promise.race([opened, result]);
        if (abort.signal.aborted) throw new Error('dsh_cancelled');
        pending = request;
        const agent = owned?.agent ?? owned;
        if (!agent?.send) throw new Error('dsh_agent_unavailable');
        const { conversation: _localHistory, ...freshContext } = context;
        freshContext.dialogue_source = 'dsh_native_session';
        Promise.resolve(agent.send({ id: randomUUID(), role: 'user', source: { kind: 'user' },
          content: [{ type: 'text', text: system + '\n' + JSON.stringify(freshContext) }] }, 'next-turn', true))
          .catch(error => request.reject(error));
        return await result;
      } catch (error) {
        await close();
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (pending === request) pending = null;
        busy = false;
        if (busyAbort === abort) busyAbort = null;
      }
    },
    close,
  };
}
