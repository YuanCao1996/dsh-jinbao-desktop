import { createHash, randomUUID } from 'node:crypto';
import { createLocalRoomRunner } from './local-runner.mjs';
import { createRoomHostClient } from './host-client.mjs';
import { createRoomCacheStore } from './cache-store.mjs';
import { createCacheReportUploader } from './cache-reports.mjs';
import { createHostUsageOutbox } from './usage-outbox.mjs';

const roomIdValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };

// Credentials use the existing CurrentUser DPAPI store. Only safe state leaves
// this native controller; neither model keys nor device proofs enter web DTOs.
export function createLocalRoomHost({ stateDir, credentials, client, getConfig, getKey, now = Date.now,
  runnerFactory = createLocalRoomRunner, deviceFactory = createRoomHostClient, moduleRoot, fetchImpl = fetch, reportFetchImpl = fetch, serviceBaseUrl, cacheStore, cacheReports, usageOutbox }) {
  const ownsCache = !cacheStore && runnerFactory === createLocalRoomRunner;
  const cacheReady = cacheStore ? Promise.resolve(cacheStore) : ownsCache ? createRoomCacheStore({ stateDir, now }) : Promise.resolve(null);
  void cacheReady.catch(() => {}); let cache = null;
  const ownsReports = !cacheReports && runnerFactory === createLocalRoomRunner;
  const reportsReady = cacheReports ? Promise.resolve(cacheReports) : ownsReports ? cacheReady.then(cacheStore => createCacheReportUploader({
    credentials, cacheStore, serviceBaseUrl, fetchImpl: reportFetchImpl, now })) : Promise.resolve(null);
  void reportsReady.catch(() => {}); let reports = null;
  const ownsUsage = !usageOutbox && runnerFactory === createLocalRoomRunner;
  const usageReady = usageOutbox ? Promise.resolve(usageOutbox) : ownsUsage ? createHostUsageOutbox({ credentials, serviceBaseUrl, fetchImpl: reportFetchImpl, now }) : Promise.resolve(null);
  void usageReady.catch(() => {}); let usage = null;
  let roomId = null, saved = null, runner = null, device = null, closed = false, queue = Promise.resolve(), executionMode = 'official', shutdownFailed = false;
  let freshProposal = false;
  let quiescedDevice = null, quiescePending = null;
  let status = { supported: true, state: 'stopped', enabled: false };
  const ref = id => 'JINBAO_TEAM_HOST_' + createHash('sha256').update(id).digest('hex');
  const view = () => ({ ...status });
  function validate(value) {
    if (!value || value.schemaVersion !== 1 || !uuid(value.deviceId) || !/^[A-Za-z0-9_-]{43}$/.test(value.deviceSecret)
      || !roomIdValid(value.proposalId) || !Number.isSafeInteger(value.expiresAt) || typeof value.enabled !== 'boolean'
      || value.privacyVersion !== undefined && (!Number.isSafeInteger(value.privacyVersion) || value.privacyVersion < 0)) fail('local_host_credential_invalid');
    return value;
  }
  const persist = () => credentials.set(ref(roomId), JSON.stringify(saved));
  async function stopRuntime() {
    const oldDevice = device, oldRunner = runner; device = null; runner = null;
    const pendingStop = oldDevice && quiescedDevice === oldDevice ? quiescePending : null;
    quiescedDevice = null; quiescePending = null;
    let error;
    for (const stop of [() => pendingStop ?? oldDevice?.stop(), () => oldRunner?.close()]) { try { await stop(); } catch (failure) { error ??= failure; } }
    if (error) { shutdownFailed = true; throw error; }
  }
  async function select(id) {
    if (!roomIdValid(id)) fail('invalid_room');
    if (roomId === id) return;
    await stopRuntime(); roomId = id; saved = null; freshProposal = false;
    const stored = await credentials.resolve(ref(id));
    if (stored) { try { saved = validate(JSON.parse(stored.value)); } catch { fail('local_host_credential_invalid'); } }
    status = { supported: true, state: saved?.enabled ? 'waiting_approval' : 'stopped', enabled: saved?.enabled === true };
  }
  async function ensureRunner() {
    if (closed) fail('team_closed');
    if (shutdownFailed) fail('local_host_restart_required');
    if (!runner) {
      const opened = await runnerFactory({ stateDir, getConfig, getKey, moduleRoot, fetchImpl, serviceBaseUrl, cacheStore: cache });
      if (closed) { await opened.close(); fail('team_closed'); }
      runner = opened;
    }
  }
  function quiesce() {
    closed = true;
    if (device && device !== quiescedDevice) {
      quiescedDevice = device;
      try { quiescePending = Promise.resolve(device.stop()); } catch (error) { quiescePending = Promise.reject(error); }
      void quiescePending.catch(() => { shutdownFailed = true; });
    }
  }
  async function discard(id, reason) {
    if (!id || !cache) return;
    if (!await cache.removeRoom(id, reason)) fail('room_cache_cleanup_pending');
    if (reports) void reports.flush().catch(() => {});
  }
  async function endAccess(id, reason) {
    let firstError;
    for (const step of [async () => { if (saved && roomId === id) { saved.enabled = false; await persist(); } },
      stopRuntime, () => discard(id, reason)]) { try { await step(); } catch (error) { firstError ??= error; } }
    status = { supported: true, state: firstError ? 'cleanup_pending' : 'stopped', enabled: false };
    if (firstError) throw firstError;
  }
  async function enforcePrivacy(room) {
    if (!saved?.enabled) return;
    const privacyVersion = room.privacyVersion ?? 0;
    if (!Number.isSafeInteger(privacyVersion) || privacyVersion < 0) fail('privacy_version_invalid');
    if (saved.privacyVersion === privacyVersion) return;
    try {
      if (!freshProposal || saved.privacyVersion !== undefined) {
        await stopRuntime();
        if (saved.privacyVersion === undefined && cache) {
          if (!await cache.clearBeforeGrant(roomId)) fail('room_cache_cleanup_pending');
          if (reports) void reports.flush().catch(() => {});
        } else await discard(roomId, 'privacy_changed');
      }
      if (saved.privacyVersion !== undefined && privacyVersion < saved.privacyVersion) fail('privacy_version_invalid');
      saved.privacyVersion = privacyVersion; await persist(); freshProposal = false;
    } catch (error) { status = { supported: true, state: 'cleanup_pending', enabled: false }; throw error; }
  }
  const serial = fn => {
    const job = queue.then(async () => { if (closed) fail('team_closed'); cache = await cacheReady; reports = await reportsReady; usage = await usageReady; return fn(); }); queue = job.catch(() => {}); return job;
  };
  return {
    view,
    quiesce,
    preparePrivacy(room) { return serial(async () => {
      if (!room || !roomIdValid(room.id)) fail('invalid_room');
      await select(room.id); await enforcePrivacy(room); return view();
    }); },
    propose(id, input) { return serial(async () => {
      if (!input || Object.keys(input).some(key => !['deviceName', 'maxTokens'].includes(key))
        || typeof input.deviceName !== 'string' || !input.deviceName.trim() || input.deviceName.length > 40
        || !Number.isSafeInteger(input.maxTokens) || input.maxTokens < 50000 || input.maxTokens > 100000000) fail('invalid_host_proposal');
      await select(id);
      if (saved?.enabled) fail('local_host_already_enabled');
      if (cache && !await cache.clearBeforeGrant(id)) fail('room_cache_cleanup_pending');
      await ensureRunner();
      try {
        const deviceId = randomUUID(), result = await client.proposeHost(id, { ...input, deviceId, protocol: 'dsh-team-v1' });
        saved = validate({ schemaVersion: 1, deviceId, deviceSecret: result.deviceSecret,
          proposalId: result.proposalId, expiresAt: result.expiresAt, enabled: true });
        await persist(); freshProposal = true; status = { supported: true, state: 'waiting_approval', enabled: true };
        return view();
      } catch (error) { saved = null; await stopRuntime(); status = { supported: true, state: 'stopped', enabled: false }; throw error; }
    }); },
    synchronize(room, remote) { return serial(async () => {
      if (!room) { await endAccess(roomId, 'access_ended'); roomId = null; saved = null; return view(); }
      await select(room.id);
      executionMode = room.executionMode ?? 'official';
      if (!saved?.enabled) {
        if (status.state === 'cleanup_pending' && !shutdownFailed && cache?.status().pending === 0) status = { ...status, state: 'stopped' };
        return view();
      }
      await enforcePrivacy(room);
      if (remote?.proposals?.some(proposal => proposal.id === saved.proposalId && proposal.expiresAt > now())) {
        await stopRuntime(); status = { supported: true, state: 'waiting_approval', enabled: true }; return view();
      }
      const ownGrant = remote?.configured && remote.memberId === room.selfMemberId;
      if (!ownGrant) {
        await endAccess(roomId, 'authorization_ended');
        await credentials.unset(ref(roomId)); saved = null;
        status = { supported: true, state: 'authorization_required', enabled: false };
        return view();
      }
      if (!remote.executionAvailable) {
        await stopRuntime(); status = { supported: true, state: 'service_disabled', enabled: true }; return view();
      }
      if (!device) {
        await ensureRunner(); const ownedRunner = runner, ownedRoom = roomId, proposalId = saved.proposalId;
        device = deviceFactory({ client, roomId, credentials: { deviceId: saved.deviceId, deviceSecret: saved.deviceSecret },
          ...(reports ? { onCacheReportToken: token => reports.register(ownedRoom, token) } : {}),
          ...(usage ? { usageOutbox: usage } : {}),
          runNativeJob: input => ownedRunner.run(input), onStatus: value => {
            if (value.state === 'authorization_required') {
              status = { supported: true, state: 'authorization_required', enabled: false };
              void serial(async () => {
                if (roomId !== ownedRoom || saved?.proposalId !== proposalId) return;
                await endAccess(ownedRoom, 'authorization_ended'); await credentials.unset(ref(ownedRoom)); saved = null;
                status = { supported: true, state: 'authorization_required', enabled: false };
              }).catch(() => {});
              return;
            }
            if (['connected', 'working', 'offline', 'task_failed', 'stopped'].includes(value.state)) status = { supported: true,
              state: value.state === 'connected' && executionMode !== 'byok' ? 'route_required' : value.state, enabled: saved?.enabled === true };
          } });
        await device.start();
      }
      // Acquire the approved device lease before selecting BYOK: the server
      // requires an online host for that switch. Polling alone runs no model;
      // only server-issued, explicitly BYOK tasks pass host-client validation.
      if (status.state === 'route_required' && executionMode === 'byok') status = { ...status, state: 'connected' };
      else if (status.state === 'connected' && executionMode !== 'byok') status = { ...status, state: 'route_required' };
      return view();
    }); },
    withdraw(id) { return serial(async () => {
      await select(id);
      // Disable locally even if the withdrawal response is lost. No further
      // model work is allowed until a fresh explicit device authorization.
      let firstError;
      for (const step of [() => endAccess(id, 'local_withdraw'), () => client.withdrawHost(id)]) {
        try { await step(); } catch (error) { firstError ??= error; }
      }
      if (firstError) throw firstError;
      await credentials.unset(ref(id)); saved = null;
      return view();
    }); },
    endAccess: id => serial(async () => { await endAccess(id ?? roomId, 'access_ended'); return view(); }),
    suspend() { return serial(async () => { await stopRuntime(); status = { ...status,
      state: status.state === 'cleanup_pending' || shutdownFailed ? 'cleanup_pending' : 'offline' }; return view(); }); },
    reconfigure() { return serial(async () => { await stopRuntime(); status = { ...status, state: saved?.enabled ? 'waiting_approval' : 'stopped' }; }); },
    async close() {
      quiesce(); await queue;
      try { await stopRuntime(); }
      finally {
        try { if (ownsUsage) await (await usageReady).close(); }
        finally { try { if (ownsReports) await (await reportsReady).close(); } finally { if (ownsCache) await (await cacheReady).close(); } }
      }
    },
  };
}
