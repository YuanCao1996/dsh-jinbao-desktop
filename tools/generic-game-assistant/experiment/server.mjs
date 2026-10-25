import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const failure = (status, reason) => Object.assign(new Error(reason), { status });
const same = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b)
  && timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function body(req) {
  if (!String(req.headers['content-type']).startsWith('application/json')) throw failure(415, 'json_required');
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw failure(413, 'body_too_large');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0;
    return value;
  } catch { throw failure(400, 'invalid_json'); }
}
function only(value, keys) {
  if (Object.keys(value).some(key => !keys.includes(key))) throw failure(400, 'unexpected_field');
}
export async function createExperimentServer({ host, port = 3094, log = () => {} } = {}) {
  const token = randomBytes(32).toString('hex');
  const events = []; let busy = false, closing = false, listing;
  const publish = value => {
    const event = { sequence: (events.at(-1)?.sequence ?? 0) + 1, time: new Date().toISOString(), ...value };
    events.push(event); if (events.length > 100) events.shift();
    try { log(event); } catch {}
  };
  const server = http.createServer(async (req, res) => {
    let authenticated = false;
    const origin = 'http://127.0.0.1:' + server.address().port;
    const send = (status, value) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); } };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (req.headers.host !== origin.slice(7) || (req.headers.origin && req.headers.origin !== origin)) throw failure(403, 'invalid_origin');
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
        res.end(await readFile(new URL('./settings.html', import.meta.url))); return;
      }
      if (!same(req.headers['x-generic-session'], token)) throw failure(403, 'authorization_required');
      authenticated = true;
      if (closing) throw failure(503, 'host_closing');
      if (req.method === 'GET' && req.url === '/api/status') {
        send(200, { ...host.runtime.status(), state: host.runtime.state(), model_ready: host.modelReady,
          model: host.modelSummary, busy, events }); return;
      }
      if (req.method === 'GET' && req.url === '/api/windows') {
        listing ??= host.windows.list().finally(() => { listing = undefined; });
        send(200, { windows: await listing }); return;
      }
      if (req.method !== 'POST') throw failure(404, 'not_found');
      const data = await body(req);
      if (req.url === '/api/stop') { only(data, []); await host.stop(); publish({ event: 'session_stopped' }); send(200, { status: 'stopped' }); return; }
      if (req.url === '/api/image-permission') {
        only(data, ['allowed']); send(200, host.runtime.setImagePermission(data.allowed)); return;
      }
      if (!['/api/start', '/api/observe', '/api/ask'].includes(req.url)) throw failure(404, 'not_found');
      if (busy) throw failure(409, 'operation_busy');
      busy = true;
      try {
        let result;
        if (req.url === '/api/start') {
          only(data, ['targetId', 'authorized', 'automatic', 'game', 'allowCloudImages']);
          result = await host.runtime.start(data);
        } else if (req.url === '/api/observe') {
          only(data, []); result = await host.runtime.observe();
        } else {
          only(data, ['question']);
          if (typeof data.question !== 'string' || !data.question.trim() || data.question.length > 2000) throw failure(400, 'invalid_question');
          if (!host.modelReady) throw failure(409, 'model_not_configured');
          publish({ event: 'question_started', chars: data.question.length });
          // Stop cancels the owned request, even while this response is pending.
          result = await host.runtime.ask(data.question);
          publish({ event: 'question_completed', status: result.status, chars: result.text?.length ?? 0 });
        }
        send(200, result);
      } finally { busy = false; }
    } catch (error) {
      const reason = /^[a-z_]+$/.test(error.message) ? error.message : 'operation_failed';
      if (authenticated) publish({ event: 'request_failed', reason });
      send(error.status ?? 400, { error: reason });
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  server.maxConnections = 12;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/#${token}`;
  return { url, publish, server, async close() {
    closing = true; await host.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  } };
}
