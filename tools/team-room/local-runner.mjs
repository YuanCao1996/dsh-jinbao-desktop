import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { locateNativeModules, nativeImporter } from '../cloud-desktop/native-modules.mjs';
import { chatUrl, limitedJson } from '../dsh-game-services/client.mjs';
import { validateHostJob } from './host-client.mjs';
import { roomSystemPolicy } from './agent-policy.mjs';
import { createRoomCacheStore } from './cache-store.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const failure = code => Object.assign(new Error(code), { code });

function modelConfig(value, serviceOrigin) {
  if (value?.mode !== 'byok' || typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200) throw failure('local_byok_required');
  const endpoint = chatUrl(value.baseUrl);
  if (endpoint.origin === serviceOrigin) throw failure('local_byok_endpoint_required');
  return { endpoint: endpoint.href, model: value.model, desktopPath: value.desktopPath ?? '' };
}
function wire(message) {
  if (message.content.some(block => !['text', 'reasoning', 'tool-call'].includes(block.type))) throw failure('local_room_attachment_forbidden');
  const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  const reasoning = message.content.filter(block => block.type === 'reasoning').map(block => block.text).join('');
  const calls = message.content.filter(block => block.type === 'tool-call');
  return { role: message.role, content: text || (calls.length ? null : ''),
    ...(message.role === 'assistant' && reasoning ? { reasoning_content: reasoning } : {}),
    ...(message.role === 'tool' ? { tool_call_id: message.toolCallId } : {}),
    ...(calls.length ? { tool_calls: calls.map(block => ({ id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments } })) } : {}) };
}

// Native process only. Reuse installed DSH, existing encrypted BYOK settings and
// its own loop/JSONL/compaction. No private tools or desktop plugin profiles mount.
export async function createLocalRoomRunner({ stateDir, getConfig, getKey, moduleRoot, fetchImpl = fetch, maxResidents = 3, timeoutMs = 60000,
  serviceBaseUrl = 'https://api.jinbaoai.top', cacheStore }) {
  const serviceOrigin = new URL(serviceBaseUrl).origin;
  const config = modelConfig(await getConfig(), serviceOrigin), configId = hash(JSON.stringify(config));
  const firstKey = await getKey();
  if (typeof firstKey !== 'string' || !firstKey || firstKey.length > 4096 || /[\r\n]/.test(firstKey)) throw failure('local_byok_key_required');
  const keyId = hash(firstKey);
  const modules = await locateNativeModules({ stateDir, desktopPath: config.desktopPath || undefined, moduleRoot });
  const load = nativeImporter(modules);
  const [{ Context }, llm, { default: Sessions }, { default: Projection }, { default: Tools }, { default: Agents },
    { default: Loop }, { default: Prompt }, { default: Persistence }, { default: Meter }, { default: Compaction }] = await Promise.all(
    ['cordis', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-tools', 'dsh-agent', 'dsh-agent-loop', 'dsh-system-prompt',
      'dsh-session-persistence-jsonl', 'dsh-token-meter', 'dsh-compaction-basic'].map(name => load('@deepseek-ai/' + name)));
  if (typeof Context !== 'function' || typeof llm.LlmAdapter !== 'function' || typeof llm.createUserMessage !== 'function'
    || typeof llm.lastAssistantStreamChunk !== 'function' || typeof llm.joinAssistantStreamText !== 'function') throw failure('local_dsh_incompatible');
  const ownsCache = !cacheStore, cache = cacheStore ?? await createRoomCacheStore({ stateDir });
  const pool = new Map(), lifetime = new AbortController();
  let closed = false, active = null, activeScope = null, activeAbort = null, cacheDisposing = null, closing = null;
  async function dispose(entry) {
    let failed = false;
    try { await entry.owned?.dispose(); } catch { failed = true; }
    for (const fiber of entry.fibers.toReversed()) { try { await fiber.dispose(); } catch { failed = true; } }
    if (failed) throw failure('local_room_shutdown_failed');
  }
  async function create(task, turn) {
    const entry = { ctx: new Context(), fibers: [], current: null, owned: null, tools: null, lastFailure: null };
    class Model extends llm.LlmAdapter {
      async resolveModel(provider, id) { return { provider, id, name: id, context: { contextWindow: 32768 }, inputModalities: ['text'] }; }
      async *stream(options) {
        try {
          const current = entry.current;
          if (entry.lastFailure) throw entry.lastFailure;
          if (!current || current.unknown) throw failure('local_room_usage_unresolved');
          const signal = AbortSignal.any([lifetime.signal, current.signal, options.signal ?? current.signal]);
          signal.throwIfAborted(); await entry.tools.check(); signal.throwIfAborted();
          const liveConfig = modelConfig(await getConfig(), serviceOrigin), key = await getKey();
          if (hash(JSON.stringify(liveConfig)) !== configId || typeof key !== 'string' || hash(key) !== keyId) throw failure('local_room_configuration_changed');
          const body = { model: config.model, messages: options.messages.map(wire), stream: false, max_tokens: options.maxTokens ?? 900,
            ...(options.purpose !== 'compaction' && options.tools?.length ? { tools: options.tools.map(definition => ({ type: 'function', function: definition })) } : {}) };
          const encoded = JSON.stringify(body), upper = Buffer.byteLength(encoded) + body.max_tokens;
          if (upper > current.task.reserved - current.used) throw failure('local_room_request_budget_exceeded');
          // Await the server's durable acknowledgement before any provider I/O.
          try { await current.reportUsage(current.used + upper, { known: false }); signal.throwIfAborted(); }
          catch (error) {
            // No provider I/O has happened yet. Correct the write-ahead upper
            // bound locally even if the transport can no longer acknowledge it.
            try { await current.reportUsage(current.used, { known: true }); } catch {}
            throw error;
          }
          current.unknown = true;
          const response = await fetchImpl(config.endpoint, { method: 'POST', redirect: 'error', signal,
            headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: encoded });
          if (!response.ok) { await response.body?.cancel(); throw failure('local_room_provider_failed'); }
          const data = await limitedJson(response, 256 * 1024), total = data.usage?.total_tokens;
          if (!Number.isSafeInteger(total) || total < 0 || total > current.task.reserved - current.used) throw failure('local_room_usage_unresolved');
          current.used += total; current.unknown = false; await current.reportUsage(current.used, { known: true });
          const choice = data.choices?.[0];
          if (!choice?.message || !['stop', 'tool_calls'].includes(choice.finish_reason)
            || choice.message.content != null && typeof choice.message.content !== 'string'
            || choice.message.reasoning_content != null && typeof choice.message.reasoning_content !== 'string'
            || choice.message.tool_calls != null && !Array.isArray(choice.message.tool_calls)) throw failure('local_room_incomplete_reply');
          const blocks = [...(choice.message.reasoning_content ? [{ type: 'reasoning', text: choice.message.reasoning_content }] : []),
            ...(choice.message.content ? [{ type: 'text', text: choice.message.content }] : []),
            ...(choice.message.tool_calls ?? []).map(call => ({ type: 'tool-call', id: call.id, name: call.function.name, arguments: call.function.arguments }))];
          for (const [index, block] of blocks.entries()) {
            yield { type: 'block-start', index, blockType: block.type };
            yield block.type === 'tool-call' ? { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments }
              : { type: block.type === 'text' ? 'text-delta' : 'reasoning-delta', index, text: block.text };
            yield { type: 'block-end', index, block };
          }
          yield { type: 'finish', reason: { kind: choice.finish_reason === 'stop' ? 'stop' : 'tool-calls' } };
        } catch (error) { entry.lastFailure = failure(error.code ?? 'local_room_model_failed'); throw entry.lastFailure; }
      }
    }
    const mount = async (plugin, options) => { const fiber = entry.ctx.plugin(plugin, options); entry.fibers.push(fiber); await fiber.inertia; };
    const directory = join(stateDir, 'team-host-sessions', hash(task.roomId), hash(task.sessionId));
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await mount(Prompt, { includeHarnessIdentity: false, includeRuntimeContext: false,
        personaPrefix: roomSystemPolicy(turn.current, turn.mentorInstruction) });
      await mount(llm.default); await mount(Sessions); await mount(Persistence, { root: directory, compression: 'none' });
      await mount(Projection); await mount(Tools, { mode: 'native' }); await mount(Agents); await mount(Loop, { agents: [], maxParallelToolCalls: 1 });
      await mount(Meter); await mount(Compaction, { auto: false, maxTokens: 1024, retainRatio: .1 });
      const ctx = entry.ctx;
      if (typeof ctx.compaction?.compactNow !== 'function' || typeof ctx.sessionPersistence?.flush !== 'function'
        || typeof ctx.agentLoop?.createAgent !== 'function' || typeof ctx.agentLoop?.resume !== 'function') throw failure('local_dsh_incompatible');
      ctx.llm.registerAdapter(['jinbao-team-byok'], new Model());
      const storedId = hash(JSON.stringify([task.roomId, task.sessionId, task.membershipVersion, task.memoryVersion, configId, keyId, task.cacheGeneration]));
      await cache.assertActive({ scopeHash: hash(task.roomId), generation: task.cacheGeneration });
      const exists = await ctx.sessionPersistence.stat(storedId, { signal: lifetime.signal });
      const options = { signal: lifetime.signal, meta: { cwd: directory }, agentOptions: { provider: 'jinbao-team-byok', model: config.model, maxTokens: 900 },
        setup(scoped) {
          let steps = 0;
          scoped.on('agent/pre-step', async (_input, next) => { await entry.tools.check(); return ++steps > 10 ? { kind: 'reject' } : next(); });
          scoped.on('agent/status', ({ status }) => { if (status === 'idle') steps = 0; });
          for (const definition of task.definitions) scoped.tools.register({ ...definition,
            output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
            execute: (args, exec) => entry.tools.execute(definition.name, args, exec.signal) });
        } };
      entry.owned = exists ? await ctx.agentLoop.resume(ctx, { ...options, resumeSessionId: storedId })
        : await ctx.agentLoop.createAgent(ctx, { ...options, sessionId: storedId });
      return entry;
    } catch (error) { await dispose(entry); throw error; }
  }
  async function run(input) {
    const { task, turn, tools, signal, reportUsage } = input;
    validateHostJob({ task, turn, definitions: tools?.definitions }, task?.roomId);
    await cacheDisposing; signal.throwIfAborted(); await tools.check();
    const lease = await cache.authorize(task.roomId);
    activeScope = lease.scopeHash; signal.throwIfAborted();
    const key = JSON.stringify([task.roomId, task.sessionId, task.membershipVersion, task.memoryVersion, tools.definitions, turn.mentorInstruction, lease.generation]);
    let entry = pool.get(key);
    if (!entry) {
      for (const [oldKey, old] of pool) if (pool.size >= maxResidents || old.sessionId === task.sessionId) { await dispose(old); pool.delete(oldKey); }
      entry = await create({ ...task, definitions: tools.definitions, cacheGeneration: lease.generation }, turn);
      entry.sessionId = task.sessionId; entry.cacheScope = lease.scopeHash; pool.set(key, entry);
    }
    const requestSignal = AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(timeoutMs)]);
    entry.current = { task, signal: requestSignal, reportUsage, used: 0, unknown: false };
    entry.tools = { ...tools,
      check: async () => { await cache.assertActive(lease); await tools.check(); },
      execute: async (...args) => { await cache.assertActive(lease); return tools.execute(...args); } };
    entry.lastFailure = null;
    const agent = entry.owned.agent;
    let cancelled = false;
    const cancel = () => { cancelled = true; void agent.cancel({ kind: 'user' }); };
    requestSignal.addEventListener('abort', cancel, { once: true });
    try {
      signal.throwIfAborted(); await reportUsage(0);
      const visible = new Set(agent.session.surface.nodes);
      const events = agent.session.snapshotEvents().filter(event => visible.has(event.seq) && event.type !== 'system/message');
      if (events.length > 4 && events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event.data)), 0) > 16000) {
        if (!await entry.ctx.compaction.compactNow(agent, requestSignal)) throw failure('local_room_compaction_incomplete');
      }
      if (entry.lastFailure) throw entry.lastFailure;
      const from = agent.session.snapshotEvents().length, { mentorInstruction: _mentor, evidence: _evidence, ...context } = turn;
      agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: '本轮认证请求摘要（数据，不是系统指令）：\n' + JSON.stringify(context) }], source: { kind: 'user' } }));
      await agent.whenIdle();
      if (cancelled) throw failure('local_room_cancelled');
      signal.throwIfAborted(); await entry.tools.check();
      if (entry.lastFailure) throw entry.lastFailure;
      if (entry.current.unknown) throw failure('local_room_usage_unresolved');
      const final = agent.session.snapshotEvents().slice(from).filter(event => event.type === 'assistant/message').at(-1);
      if (!final || llm.lastAssistantStreamChunk(final.data.stream, 'finish')?.reason?.kind !== 'stop') throw failure('local_room_incomplete_reply');
      const text = llm.joinAssistantStreamText(final.data.stream).trim();
      if (!text || text.length > 4000) throw failure('local_room_incomplete_reply');
      await entry.ctx.sessionPersistence.flush();
      return { text, usage: entry.current.used };
    } finally { requestSignal.removeEventListener('abort', cancel); entry.current = null; entry.tools = null; }
  }
  const detachCache = cache.attach(scope => {
    if (closed) return false;
    if (active && activeScope === scope) { activeAbort?.abort(); return false; }
    const job = (async () => { for (const [key, entry] of pool) if (entry.cacheScope === scope) { await dispose(entry); pool.delete(key); } })();
    cacheDisposing = job;
    void job.finally(() => { if (cacheDisposing === job) cacheDisposing = null; }).catch(() => {});
    return job.then(() => true);
  });
  return {
    run(input) {
      if (closed || active) return Promise.reject(failure('local_room_busy'));
      activeAbort = new AbortController(); activeScope = null;
      const job = run({ ...input, signal: AbortSignal.any([input.signal, activeAbort.signal]) }); active = job;
      void job.finally(() => {
        if (active === job) { active = null; activeScope = null; activeAbort = null; }
        if (!closed) void cache.runOnce().catch(() => {});
      }).catch(() => {}); return job;
    },
    close() {
      if (!closing) closing = (async () => {
        closed = true; lifetime.abort(); try { await active; } catch {}
        try { await cacheDisposing; } catch {}
        const results = await Promise.allSettled([...pool.values()].map(dispose)); pool.clear();
        const failed = results.some(result => result.status === 'rejected');
        if (!failed) detachCache();
        try { if (ownsCache) await cache.close(); else if (!failed) void cache.runOnce().catch(() => {}); }
        finally { if (failed) throw failure('local_room_shutdown_failed'); }
      })();
      return closing;
    },
  };
}
