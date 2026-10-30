import { readFile } from 'node:fs/promises';

const send = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value));
};
export async function serveTeamPage(req, res) {
  const pages = {
    '/team-room': ['page.html', 'text/html; charset=utf-8'],
    '/team-assets/page.css': ['page.css', 'text/css; charset=utf-8'],
    '/team-assets/page.mjs': ['page.mjs', 'text/javascript; charset=utf-8'],
    '/team-assets/native-api.mjs': ['native-api.mjs', 'text/javascript; charset=utf-8'],
    '/team-assets/mobile-session.mjs': ['mobile-session.mjs', 'text/javascript; charset=utf-8'],
    '/team-assets/client.mjs': ['client.mjs', 'text/javascript; charset=utf-8'],
  };
  const page = pages[req.url];
  if (!page || req.method !== 'GET') return false;
  res.writeHead(200, { 'Content-Type': page[1], 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
  res.end(await readFile(new URL(page[0], import.meta.url))); return true;
}

// The setup server enforces loopback Host, nonce and Origin before calling.
export function createTeamLocalRoutes(team) {
  return async (req, res) => {
    if (!req.url.startsWith('/api/team/')) return false;
    try {
      if (req.method === 'GET' && req.url === '/api/team/status') { send(res, 200, team.view()); return true; }
      if (req.method !== 'POST' || req.url !== '/api/team/command' || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) {
        send(res, 404, { error: '操作不存在。' }); return true;
      }
      const chunks = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length; if (bytes > 16_384) throw Object.assign(new Error(), { status: 413 }); chunks.push(chunk);
      }
      const value = JSON.parse(Buffer.concat(chunks));
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['action', 'data'].includes(key))
        || typeof value.action !== 'string' || value.action.length > 40 || value.data !== undefined
        && (!value.data || typeof value.data !== 'object' || Array.isArray(value.data))) throw Object.assign(new Error(), { status: 400 });
      send(res, 200, await team.command(value.action, value.data));
    } catch (error) {
      const message = error.userMessage && !/[/\\]|\b(?:secret|Bearer|token|api.?key)\b/i.test(error.userMessage) ? error.userMessage : '队伍操作未完成，请检查登录或稍后重试。';
      send(res, [400, 401, 403, 404, 409, 413, 429, 503].includes(error.status) ? error.status : 400, { error: message });
    }
    return true;
  };
}
