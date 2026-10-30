import { createHash } from 'node:crypto';
import { serviceUrl, limitedJson } from '../dsh-game-services/client.mjs';
import { usageReportPayload, usageReportHash, usageReportId, usageReportScope } from './usage-report-format.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const time = value => Number.isSafeInteger(value) && value >= 0;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const MAX_ITEMS = 128, AUDIT_AGE = 90 * 86400000;
const dispositions = new Set(['settled', 'already_settled', 'held', 'review_required']);
const payload = row => usageReportPayload({ seq: row.seq, usage: row.usage, known: row.known, finalized: true });
function validate(row, taskId) {
  if (!row || Array.isArray(row) || Object.keys(row).some(key => !['v', 'token', 'seq', 'usage', 'known', 'knownFloor', 'finalized', 'createdAt', 'updatedAt', 'ack'].includes(key))
    || row.v !== 1 || !time(row.createdAt) || !time(row.updatedAt) || typeof row.finalized !== 'boolean') fail('usage_outbox_invalid');
  let scope; try { scope = usageReportScope(row.token); payload(row); } catch { fail('usage_outbox_invalid'); }
  if (scope.jobId !== taskId || row.usage > scope.reserved || !time(row.knownFloor) || row.knownFloor > row.usage || row.known && row.knownFloor !== row.usage) fail('usage_outbox_invalid');
  if (row.ack && (!row.finalized || Object.keys(row.ack).some(key => !['id', 'receivedAt', 'disposition'].includes(key))
    || !hex(row.ack.id) || !time(row.ack.receivedAt) || !dispositions.has(row.ack.disposition))) fail('usage_outbox_invalid');
  return row;
}

// Native-only, separate from disposable Agent/session caches. Every checkpoint
// is encrypted and fsynced before the host transport/provider may proceed.
// Only one desktop process owns this outbox. Restart seals prior stopped work;
// no Agent, private content, login or model key is loaded for recovery/upload.
export async function createHostUsageOutbox({ credentials, serviceBaseUrl = 'https://api.jinbaoai.top', fetchImpl = fetch,
  now = Date.now, intervalMs = 60000, timeoutMs = 10000, trace = () => {} }) {
  const service = serviceUrl(serviceBaseUrl); if (service.pathname !== '/') fail('invalid_usage_report_service');
  const originHash = hash(service.origin), indexKey = 'JINBAO_USAGE_INDEX_' + originHash;
  const key = taskId => 'JINBAO_USAGE_RECORD_' + hash(originHash + ':' + taskId);
  const rows = new Map(); let ids = [], queue = Promise.resolve(), closed = false, timer, currentAbort, flushJob, nextAttempt = 0, state = 'idle';
  const serial = fn => { const job = queue.then(fn); queue = job.catch(() => {}); return job; };
  const notify = event => { try { trace({ event }); } catch {} };
  const saveIndex = async next => { await credentials.set(indexKey, JSON.stringify({ v: 1, tasks: next })); ids = next; };
  const saveRow = async (taskId, value) => { validate(value, taskId); await credentials.set(key(taskId), JSON.stringify(value)); rows.set(taskId, value); };
  const saved = await credentials.resolve(indexKey);
  if (saved) {
    let index; try { index = JSON.parse(saved.value); } catch { fail('usage_outbox_invalid'); }
    if (index?.v !== 1 || !Array.isArray(index.tasks) || index.tasks.length > MAX_ITEMS || new Set(index.tasks).size !== index.tasks.length
      || index.tasks.some(value => typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value))) fail('usage_outbox_invalid');
    ids = index.tasks;
    for (const id of ids) {
      const record = await credentials.resolve(key(id)); if (!record) fail('usage_outbox_invalid');
      let row; try { row = JSON.parse(record.value); } catch { fail('usage_outbox_invalid'); }
      validate(row, id); rows.set(id, row);
      if (!row.finalized) await saveRow(id, { ...row, finalized: true, updatedAt: now() });
    }
  }
  async function remove(id) {
    // Index first: a crash can leave an encrypted orphan, never a live index
    // pointing to a missing pending financial record. Only acknowledged rows go.
    await saveIndex(ids.filter(value => value !== id)); await credentials.unset(key(id)); rows.delete(id);
  }
  async function prune(forCapacity = false) {
    const done = [...rows.entries()].filter(([, row]) => row.ack).sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (const [id, row] of done) {
      if (now() >= row.updatedAt + AUDIT_AGE || forCapacity && ids.length >= MAX_ITEMS) await remove(id);
    }
  }
  async function flushNow() {
    if (closed || now() < nextAttempt) return;
    try {
      const pending = [...rows.entries()].filter(([, row]) => row.finalized && !row.ack).slice(0, 5);
      for (const [id, row] of pending) {
        if (closed) break;
        state = 'sending'; currentAbort = new AbortController(); const report = payload(row);
        const response = await fetchImpl(new URL('/desktop/team-retention/host-usage', service), { method: 'POST', redirect: 'error',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: row.token, report }),
          signal: AbortSignal.any([currentAbort.signal, AbortSignal.timeout(timeoutMs)]) });
        if (!response.ok) { await response.body?.cancel(); throw new Error('usage_report_pending'); }
        const ack = await limitedJson(response, 4096);
        if (ack?.state !== 'usage_report_received' || ack.reportId !== usageReportId(row.token, report) || ack.reportHash !== usageReportHash(report)
          || !hex(ack.ackId) || !time(ack.receivedAt) || !dispositions.has(ack.disposition)) fail('usage_report_ack_mismatch');
        await serial(async () => {
          const current = rows.get(id); if (!current || current.ack || !current.finalized || usageReportHash(payload(current)) !== ack.reportHash) fail('usage_report_ack_mismatch');
          await saveRow(id, { ...current, ack: { id: ack.ackId, receivedAt: ack.receivedAt, disposition: ack.disposition } });
        });
        notify('team_usage_report_received'); currentAbort = null;
      }
      state = closed ? 'stopped' : [...rows.values()].some(row => row.finalized && !row.ack) ? 'pending' : 'idle';
      if (state === 'pending') nextAttempt = now() + intervalMs;
      if (!closed) await serial(() => prune());
    } catch { state = closed ? 'stopped' : 'pending'; nextAttempt = now() + intervalMs; if (!closed) notify('team_usage_report_pending'); }
    finally { currentAbort = null; }
  }
  function flush() {
    if (!flushJob) { const job = flushNow(); flushJob = job; void job.finally(() => { if (flushJob === job) flushJob = null; }).catch(() => {}); }
    return flushJob;
  }
  timer = setInterval(() => { void flush(); }, intervalMs); timer.unref(); void flush();
  return {
    async begin(task, token) { return serial(async () => {
      if (closed) fail('usage_outbox_closed'); const scope = usageReportScope(token);
      if (scope.roomId !== task.roomId || scope.jobId !== task.id || scope.reserved !== task.reserved) fail('usage_report_scope_mismatch');
      const old = rows.get(task.id); if (old) fail('usage_task_already_recorded');
      await prune(true); if (ids.length >= MAX_ITEMS) fail('usage_outbox_capacity');
      const at = now(), row = { v: 1, token, seq: 0, usage: 0, known: true, knownFloor: 0, finalized: false, createdAt: at, updatedAt: at };
      await saveRow(task.id, row);
      try { await saveIndex([...ids, task.id]); } catch (error) { rows.delete(task.id); throw error; }
    }); },
    checkpoint(taskId, input) { return serial(async () => {
      if (closed) fail('usage_outbox_closed'); const row = rows.get(taskId);
      if (!row || row.finalized) fail('usage_task_stopped');
      const report = usageReportPayload({ ...input, finalized: true });
      if (report.seq !== row.seq + 1 || report.usage < row.knownFloor) fail('usage_checkpoint_conflict');
      await saveRow(taskId, { ...row, seq: report.seq, usage: report.usage, known: report.known,
        knownFloor: report.known ? report.usage : row.knownFloor, updatedAt: now() });
    }); },
    finalize(taskId) { return serial(async () => {
      if (closed) fail('usage_outbox_closed'); const row = rows.get(taskId); if (!row) fail('usage_task_unavailable');
      if (!row.finalized) await saveRow(taskId, { ...row, finalized: true, updatedAt: now() });
    }); },
    flush,
    status() {
      const values = [...rows.values()]; return { supported: true, state, pending: values.filter(row => !row.ack).length,
        received: values.filter(row => row.ack).length, held: values.filter(row => ['held', 'review_required'].includes(row.ack?.disposition)).length };
    },
    async close() { closed = true; clearInterval(timer); currentAbort?.abort(); await queue; await flushJob; state = 'stopped'; },
  };
}
