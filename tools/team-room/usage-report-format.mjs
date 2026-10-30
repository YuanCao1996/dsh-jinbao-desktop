import { createHash } from 'node:crypto';

const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const fail = () => { throw Object.assign(new Error('invalid_usage_report'), { code: 'invalid_usage_report', status: 400 }); };
export function usageReportPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'finalized,known,seq,usage'
    || !Number.isSafeInteger(value.seq) || value.seq < 0 || value.seq > 100
    || !Number.isSafeInteger(value.usage) || value.usage < 0 || value.usage > 50000
    || typeof value.known !== 'boolean' || value.finalized !== true) fail();
  return { seq: value.seq, usage: value.usage, known: value.known, finalized: true };
}
export const usageReportHash = value => createHash('sha256').update(JSON.stringify(usageReportPayload(value))).digest('hex');
export const usageReportId = (token, value) => createHash('sha256').update(token + ':' + usageReportHash(value)).digest('hex');
// Shape validation only: native code receives this capability over an already
// authenticated host channel; the server independently verifies its signature.
export function usageReportScope(token) {
  if (typeof token !== 'string' || token.length > 2048 || !/^jhu1\.[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(token)) fail();
  let value; try { value = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch { fail(); }
  if (!value || Object.keys(value).sort().join(',') !== 'bindingId,budgetId,issuerHash,jobId,leaseId,purpose,reserved,roomId,v'
    || value.v !== 1 || value.purpose !== 'host-usage' || !/^[a-f0-9]{64}$/.test(value.issuerHash)
    || ![value.roomId, value.jobId, value.budgetId, value.bindingId, value.leaseId].every(id)
    || !Number.isSafeInteger(value.reserved) || value.reserved < 1 || value.reserved > 50000) fail();
  return value;
}
