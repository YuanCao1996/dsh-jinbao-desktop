import { validateRoi } from './contracts.mjs';

export function createAdaptiveScheduler({ now = () => performance.now(), maxCapturesPerMinute = 40 } = {}) {
  if (!Number.isSafeInteger(maxCapturesPerMinute) || maxCapturesPerMinute < 1 || maxCapturesPerMinute > 60) {
    throw new Error('invalid_capture_budget');
  }
  let plan = null;
  let lastAt = -Infinity;
  let stable = 0;
  let failures = 0;
  let captures = [];
  let boostUntil = 0;
  let lastOverview = null;
  let regionIndex = 0;
  return {
    propose(value) {
      if (!value || Object.keys(value).some(key => !['roi', 'regions', 'quality', 'task', 'interval_ms', 'duration_ms'].includes(key))) {
        throw new Error('invalid_observation_plan');
      }
      const task = value.task ?? 'general';
      if (!['general','layout','text'].includes(task)) throw new Error('invalid_observation_task');
      const { quality = task === 'text' ? 'detail' : task === 'layout' ? 'overview' : 'standard', interval_ms: interval = 2000, duration_ms: duration = 30000 } = value;
      if (!['overview', 'standard', 'detail'].includes(quality)
          || !Number.isSafeInteger(interval) || interval < 1000 || interval > 15000
          || !Number.isSafeInteger(duration) || duration < 1000 || duration > 30000) {
        throw new Error('invalid_observation_plan');
      }
      plan = { roi: validateRoi(value.roi ?? { x: 0, y: 0, width: 1, height: 1 }), quality,
        interval_ms: interval, expires_at: now() + duration };
      if (value.regions != null) {
        if (value.roi || !Array.isArray(value.regions) || !value.regions.length || value.regions.length > 4) {plan=null;throw new Error('invalid_regions');}
        try { plan.regions = value.regions.map(validateRoi); } catch(error) {plan=null;throw error;}
      }
      regionIndex=0;
      if (lastOverview === null) lastOverview = now();
      return this.status();
    },
    admit({ active, manual = false } = {}) {
      const at = now();
      if (!active) return { allowed: false, reason: 'target_not_active', retry_ms: 6000 };
      const recoveryDelay = Math.min(60000, 15000 * 2 ** Math.min(2, Math.max(0, failures - 3)));
      if (failures >= 3 && !manual && at - lastAt < recoveryDelay) return { allowed: false, reason: 'observation_paused', retry_ms: recoveryDelay - (at - lastAt) };
      captures = captures.filter(value => at - value < 60000);
      if (captures.length >= maxCapturesPerMinute) {
        return { allowed: false, reason: 'capture_budget_exhausted', retry_ms: Math.max(1000, 60000 - (at - captures[0])) };
      }
      const current = failures >= 3 ? null : plan && plan.expires_at > at ? plan : null;
      const automaticInterval = failures ? 5000 : at < boostUntil ? 1000 : stable >= 2 ? 6000 : 2000;
      const interval = manual ? 1000 : Math.max(automaticInterval, current?.interval_ms ?? 1000);
      if (at - lastAt < interval) {
        return { allowed: false, reason: 'observation_cooldown', retry_ms: interval - (at - lastAt) };
      }
      lastAt = at;
      captures.push(at);
      const roi = current?.regions ? current.regions[regionIndex % current.regions.length] : current?.roi;
      const local = current && (roi.width < 1 || roi.height < 1);
      const overview = !manual && local && at - (lastOverview ?? at) >= 15000;
      if (overview || !local) lastOverview = at;
      if (!overview && current?.regions) regionIndex++;
      return { allowed: true, reason:overview?'overview_patrol':'planned',request: { quality: overview ? 'overview' : current?.quality ?? 'overview',
        ...(current && !overview ? { roi: { ...roi } } : {}), minIntervalMs: interval } };
    },
    complete({ changed, ok }) {
      if (!ok) { failures += 1; stable = 0; return; }
      failures = 0;
      if (changed) { stable = 0; boostUntil = now() + 5000; } else stable += 1;
    },
    resetPlan() { plan = null; },
    feedback({readable}) {
      if (!plan || typeof readable !== 'boolean') return;
      if (!readable) {
        if (plan.quality === 'overview') plan.quality='standard';
        else if (plan.quality === 'standard') plan.quality='detail';
        else plan=null; // Detail still unreadable: reacquire overview instead of looping.
      }
    },
    status() {
      const at = now();
      return { stable_frames: stable, consecutive_failures: failures,
        paused: failures >= 3, captures_in_last_minute: captures.filter(value => at - value < 60000).length,
        max_captures_per_minute: maxCapturesPerMinute,
        plan: plan && plan.expires_at > at ? structuredClone(plan) : null };
    },
  };
}
