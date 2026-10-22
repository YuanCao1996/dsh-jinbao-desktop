import { timingSafeEqual } from 'node:crypto';

export async function authenticateLocalRequest(req, credentials) {
  if (req.headers.origin !== undefined || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return 403;
  let token;
  try { token = (await credentials?.resolve('JINBAO_LOCAL_ACCESS_KEY'))?.value; } catch { return 503; }
  const supplied = req.headers.authorization;
  if (typeof token !== 'string' || !token || typeof supplied !== 'string') return 401;
  const expected = Buffer.from('Bearer ' + token), actual = Buffer.from(supplied);
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? 0 : 401;
}

// Runs before parsing bodies, opening streams or invoking an Agent.
export async function guardCoachRequest(req, res, { credentials, port, desktop }) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  const reject = status => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'request_denied' }));
    return false;
  };
  if (req.headers.host !== `127.0.0.1:${port}`) return reject(403);
  const denied = await authenticateLocalRequest(req, credentials);
  if (denied) return reject(denied);
  if (desktop && !['GET /health', 'GET /coach/state', 'POST /coach/chat'].includes(`${req.method} ${req.url}`)) return reject(404);
  if (req.method === 'OPTIONS') return reject(405);
  return true;
}
