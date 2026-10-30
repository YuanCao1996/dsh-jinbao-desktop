import { createHash } from 'node:crypto';

const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const reasons = new Set(['expired', 'clock_changed', 'legacy_unindexed', 'authorization_ended', 'local_withdraw', 'access_ended', 'new_authorization', 'privacy_changed']);
export function cacheReceiptPayload(value) {
  const allowed = ['id', 'scopeHash', 'generation', 'deletedAt', 'reason', 'state'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))
    || typeof value.id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.id) || !hex(value.scopeHash)
    || !Number.isSafeInteger(value.generation) || value.generation < 1 || !Number.isSafeInteger(value.deletedAt) || value.deletedAt < 0
    || !reasons.has(value.reason) || value.state !== 'local_deleted') throw Object.assign(new Error('invalid_cache_report'), { code: 'invalid_cache_report', status: 400 });
  return { id: value.id, scopeHash: value.scopeHash, generation: value.generation, deletedAt: value.deletedAt, reason: value.reason, state: 'local_deleted' };
}
export const cacheReceiptHash = value => createHash('sha256').update(JSON.stringify(cacheReceiptPayload(value))).digest('hex');
