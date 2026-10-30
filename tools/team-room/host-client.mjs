import { randomUUID } from 'node:crypto';

const allowed = new Set(['get_current_match', 'get_match_recap_facts', 'get_member_state', 'get_members_state', 'query_room_matches',
  'query_match_events', 'query_room_messages', 'search_memories', 'propose_memory', 'request_member_confirmation',
  'query_game_knowledge', 'search_game_guides']);
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const authorityEnded = error => ['host_authorization_required', 'room_forbidden', 'room_unavailable', 'membership_removed'].includes(error?.code);
export function validateHostJob(job, roomId) {
  if (!job || job.task?.roomId !== roomId || !id(job.task.id) || job.task.executionMode !== 'byok'
    || typeof job.task.sessionId !== 'string' || job.task.sessionId.length > 300
    || !Number.isSafeInteger(job.task.reserved) || job.task.reserved < 1 || job.task.reserved > 50000
    || !Number.isSafeInteger(job.task.membershipVersion) || !Number.isSafeInteger(job.task.memoryVersion)
    || !Array.isArray(job.definitions) || job.definitions.length > allowed.size || !job.turn || typeof job.turn !== 'object'
    || new Set(job.definitions.map(value => value.name)).size !== job.definitions.length
    || job.definitions.some(value => !allowed.has(value.name)) || Buffer.byteLength(JSON.stringify(job)) > 48000) throw new Error('invalid_host_job');
}

// Native process only. The web page never receives device credentials or model
// keys. runNativeJob must mount an isolated DSH runtime with only these RPC tools.
export function createRoomHostClient({ client, roomId, credentials, runNativeJob, onStatus = () => {}, now = Date.now,
  instanceId = randomUUID(), pollMs = 2000, heartbeatMs = 5000, onCacheReportToken, usageOutbox }) {
  if (!client || !id(roomId) || !credentials || typeof runNativeJob !== 'function') throw new Error('invalid_host_client');
  let lease = null, stopped = true, heartbeatTimer, pollTimer, heartbeating = false, polling = false, current = null, epoch = 0, lifetime;
  const seen = new Set();
  const proof = () => ({ deviceId: credentials.deviceId, deviceSecret: credentials.deviceSecret, instanceId, ...(lease ? { leaseId: lease.leaseId } : {}) });
  function notify(state) { try { onStatus({ state }); } catch {} }
  async function heartbeat() {
    if (stopped || heartbeating) return;
    heartbeating = true; const generation = epoch;
    try {
      if (!lease) {
        if (current) return;
        const acquired = await client.acquireHost(roomId, proof(), lifetime.signal);
        if (stopped || epoch !== generation) return;
        if (onCacheReportToken) await onCacheReportToken(acquired.cacheReportToken);
        if (stopped || epoch !== generation) return;
        lease = acquired;
      } else {
        const renewed = await client.heartbeatHost(roomId, proof(), lifetime.signal);
        if (stopped || epoch !== generation) return;
        if (onCacheReportToken) await onCacheReportToken(renewed.cacheReportToken);
        if (stopped || epoch !== generation) return;
        lease = { ...lease, ...renewed };
      }
      if (current && !current.finishing) await client.checkHost(roomId, current.proof, current.jobId, lifetime.signal);
      if (!stopped) notify(current ? 'working' : 'connected');
    } catch (error) {
      if (epoch === generation) { lease = null; current?.controller.abort(); notify(stopped ? 'stopped' : authorityEnded(error) ? 'authorization_required' : 'offline'); }
    } finally { heartbeating = false; }
  }
  async function execute(job, jobProof, controller) {
    let seq = 0, journal = Promise.resolve(), usageStarted = false;
    const { signal } = controller, names = new Set(job.definitions.map(value => value.name));
    const reportUsage = (usage, { known = true } = {}) => {
      if (!Number.isSafeInteger(usage) || usage < 0 || usage > job.task.reserved || typeof known !== 'boolean') throw new Error('invalid_host_usage');
      const request = { jobId: job.task.id, seq: ++seq, usage, known };
      const previous = journal;
      // Local persistence continues even if an earlier network acknowledgement
      // failed, so a final known count can survive revocation and cache deletion.
      const saved = usageStarted ? usageOutbox.checkpoint(job.task.id, { seq: request.seq, usage, known }) : Promise.resolve();
      journal = (async () => { await saved; await previous; return client.recordHostUsage(roomId, jobProof, request, signal); })();
      void journal.catch(() => controller.abort()); return journal;
    };
    const check = async () => { signal.throwIfAborted(); await client.checkHost(roomId, jobProof, job.task.id, signal); signal.throwIfAborted(); };
    try {
      if (usageOutbox && !job.usageReportToken) throw new Error('usage_report_authority_required');
      if (job.usageReportToken) {
        if (!usageOutbox) throw new Error('usage_outbox_required');
        await usageOutbox.begin(job.task, job.usageReportToken); usageStarted = true;
      }
      await check();
      const result = await runNativeJob({ task: job.task, turn: job.turn, signal, reportUsage,
        tools: { definitions: job.definitions, check, async execute(name, args, toolSignal) {
          signal.throwIfAborted(); toolSignal?.throwIfAborted();
          if (!names.has(name)) throw new Error('tool_not_allowed');
          const value = await client.executeHostTool(roomId, jobProof, { jobId: job.task.id, callId: randomUUID(), name, args }, signal);
          signal.throwIfAborted(); toolSignal?.throwIfAborted(); return value;
        } } });
      await journal; signal.throwIfAborted();
      if (!result || typeof result.text !== 'string' || !result.text.trim() || result.text.length > 4000
        || !Number.isSafeInteger(result.usage) || result.usage < 0 || result.usage > job.task.reserved) throw new Error('invalid_host_result');
      await reportUsage(result.usage); await check();
      const request = { jobId: job.task.id, text: result.text, usage: result.usage };
      if (current?.controller === controller) current.finishing = true;
      // Retrying a final acknowledgement never re-runs DSH or the provider.
      try { await client.completeHost(roomId, jobProof, request, signal); }
      catch (error) { signal.throwIfAborted(); if (error.status && error.status < 500) throw error; await client.completeHost(roomId, jobProof, request, signal); }
      notify('connected');
    } catch {
      try { await journal; } catch {}
      try { await client.failHost(roomId, jobProof, job.task.id); } catch {}
      notify(stopped ? 'stopped' : 'task_failed');
    } finally {
      if (usageStarted) {
        try { await usageOutbox.finalize(job.task.id); void usageOutbox.flush(); }
        catch { notify(stopped ? 'stopped' : 'task_failed'); }
      }
    }
  }
  async function poll() {
    if (stopped || polling || current || !lease || lease.leaseUntil <= now()) return;
    polling = true; const generation = epoch;
    try {
      const jobProof = proof(), { job } = await client.pollHost(roomId, jobProof, lifetime.signal);
      if (!job || stopped || epoch !== generation) return;
      validateHostJob(job, roomId);
      if (seen.has(job.task.id)) return;
      seen.add(job.task.id); while (seen.size > 200) seen.delete(seen.values().next().value);
      const controller = new AbortController();
      const running = { controller, promise: null, proof: jobProof, jobId: job.task.id, finishing: false }; current = running; notify('working');
      running.promise = execute(job, jobProof, controller).finally(() => { if (current === running) current = null; });
    } catch { if (!stopped && epoch === generation) notify('offline'); }
    finally { polling = false; }
  }
  return {
    async start() {
      if (!stopped) return;
      stopped = false; epoch++; lifetime = new AbortController(); await heartbeat();
      if (stopped) return;
      heartbeatTimer = setInterval(() => { void heartbeat(); }, heartbeatMs); heartbeatTimer.unref();
      pollTimer = setInterval(() => { void poll(); }, pollMs); pollTimer.unref();
      await poll();
    },
    heartbeat, poll,
    async idle() { await current?.promise; },
    async stop() {
      stopped = true; epoch++; clearInterval(heartbeatTimer); clearInterval(pollTimer); lifetime?.abort(); lease = null;
      current?.controller.abort(); await current?.promise; notify('stopped');
    },
  };
}
