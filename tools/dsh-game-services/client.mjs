export function serviceUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('HTTPS service URL required');
  return url;
}
export function chatUrl(value) {
  const base = serviceUrl(value);
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  return new URL('chat/completions', base);
}
export async function limitedJson(response, maxBytes = 128 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error('response exceeds limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks));
}

export function createGameClient({ serviceBaseUrl, serviceToken, model, fetchImpl = fetch }) {
  const service = serviceBaseUrl ? serviceUrl(serviceBaseUrl) : undefined;
  async function request(url, token, body, signal) {
    if (!token) throw new Error('credential is required');
    let response;
    try {
      response = await fetchImpl(url, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: signal ?? AbortSignal.timeout(60000) });
    } catch { throw new Error('service connection failed'); }
    if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(`service HTTP ${response.status}`), { status: response.status }); }
    return response;
  }
  return {
    async catalog(signal) {
      if (!service) throw new Error('retrieval service not configured');
      return limitedJson(await request(new URL('/site/catalog', service), serviceToken, undefined, signal));
    },
    async search(query, signal) {
      if (!service) throw new Error('retrieval service not configured');
      return limitedJson(await request(new URL('/site/search', service), serviceToken, query, signal));
    },
    async complete(chat, signal) {
      if (!model || !['byok', 'proxy'].includes(model.mode)) throw new Error('model mode is required');
      let url;
      let token;
      if (model.mode === 'byok') {
        url = chatUrl(model.baseUrl);
        if (service && url.origin === service.origin) throw new Error('BYOK must use a separate model endpoint');
        token = model.apiKey;
      } else {
        if (!service) throw new Error('model proxy not configured');
        url = new URL('/v1/chat/completions', service);
        token = serviceToken;
      }
      // No provider key, service token, or mode is embedded in model messages.
      const response = await request(url, token, { ...chat, model: model.id }, signal);
      return chat.stream ? response : limitedJson(response, 2 * 1024 * 1024);
    },
  };
}
