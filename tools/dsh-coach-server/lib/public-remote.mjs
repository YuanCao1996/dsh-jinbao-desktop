import { uploadCandidates, mergeRemote } from './public-sync.mjs';

// One round trip between this machine and the community library.
//
// The client never decides what is shareable here: uploadCandidates applies the anonymisation gate,
// and this function only moves the result. If the server is unreachable the local library keeps
// working — a shared library is an enhancement, never a dependency.

const ENDPOINT = '/api/public/experience';

export async function syncPublicMemory({
  store, dir, baseUrl, fetchImpl = fetch, token = null, game = 'lol', patch = null, limit = 50,
} = {}) {
  if (!store || !dir) throw new Error('sync needs a store and its directory');
  if (!baseUrl) return { skipped: 'no-endpoint' };
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;

  let uploaded = 0;
  let rejected = 0;
  let serverResult = null;
  try {
    const up = await uploadCandidates(store);
    rejected = up.rejected.length;
    if (up.lessons.length) {
      const response = await fetchImpl(baseUrl + ENDPOINT, { method: 'POST', headers, body: JSON.stringify({ lessons: up.lessons }) });
      if (!response.ok) return { error: 'upload-failed', status: response.status, rejected };
      serverResult = await response.json();
      uploaded = up.lessons.length;
    }
  } catch (error) {
    return { error: 'upload-threw', message: String(error?.message ?? error), rejected };
  }

  try {
    const query = new URLSearchParams({ game, limit: String(limit) });
    if (patch) query.set('patch', patch);
    const response = await fetchImpl(baseUrl + ENDPOINT + '?' + query.toString(), { headers });
    if (!response.ok) return { error: 'download-failed', status: response.status, uploaded, rejected };
    const payload = await response.json();
    const lessons = Array.isArray(payload?.lessons) ? payload.lessons : [];
    const merged = await mergeRemote(store, dir, lessons);
    return { uploaded, rejected, serverResult, fetched: lessons.length, merged };
  } catch (error) {
    return { error: 'download-threw', message: String(error?.message ?? error), uploaded, rejected };
  }
}
