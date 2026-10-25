export function createObservationPolicy({ now = () => performance.now(),
  minIntervalMs = 1000, cloudCooldownMs = 10000, maxCloudCalls = 30 } = {}) {
  if (![minIntervalMs, cloudCooldownMs, maxCloudCalls].every(Number.isSafeInteger)
      || minIntervalMs < 500 || cloudCooldownMs < 1000 || maxCloudCalls < 1 || maxCloudCalls > 100) {
    throw new Error('invalid_observation_budget');
  }
  let lastCapture = -Infinity;
  let lastCloud = -Infinity;
  let cloudCalls = 0;
  const analyzed = new Set();
  return {
    capture({ enabled, visible, foreground, intervalMs = minIntervalMs }) {
      if (!enabled) return { allowed: false, reason: 'disabled' };
      if (!visible || !foreground) return { allowed: false, reason: 'target_not_active' };
      if (!Number.isSafeInteger(intervalMs) || intervalMs < 500 || intervalMs > 60000) {
        throw new Error('invalid_observation_interval');
      }
      const at = now();
      if (at - lastCapture < Math.max(minIntervalMs, intervalMs)) return { allowed: false, reason: 'capture_cooldown' };
      lastCapture = at;
      return { allowed: true };
    },
    cloud({ positionHash, reason = 'position_changed' }) {
      if (typeof positionHash !== 'string' || !/^[a-f0-9]{64}$/.test(positionHash)) {
        throw new Error('invalid_position_hash');
      }
      if (!['position_changed', 'user_question', 'recognition_conflict'].includes(reason)) {
        throw new Error('invalid_analysis_reason');
      }
      if (reason !== 'user_question' && analyzed.has(positionHash)) {
        return { allowed: false, reason: 'position_already_analyzed' };
      }
      if (cloudCalls >= maxCloudCalls) return { allowed: false, reason: 'cloud_budget_exhausted' };
      const at = now();
      if (at - lastCloud < cloudCooldownMs) return { allowed: false, reason: 'cloud_cooldown' };
      // Failures also consume budget: a broken provider must not cause a retry storm.
      lastCloud = at;
      cloudCalls += 1;
      analyzed.add(positionHash);
      return { allowed: true };
    },
    status() { return { cloud_calls: cloudCalls, max_cloud_calls: maxCloudCalls }; },
  };
}
