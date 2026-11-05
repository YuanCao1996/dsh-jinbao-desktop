import { buildInjection, contextTags } from '../dsh-coach-server/lib/public-injector.mjs';

// 服务端注入接口：客户端只发"当前局面"，只收"建议"。
//
// 这是"经验原文永不下发"的落地层：经验在服务端查库、拼进提示词、交给模型，响应里只有建议文本。
// 因此即便有人反编译客户端或抓包，也拿不到经验库本身。
//
// 鉴权是硬要求：没有授权就不回任何数据（读经验要登录）。authorize 由网关提供，这里不猜令牌形式。

const PATH = '/api/coach/inject';
const MAX_BODY = 8 * 1024;

function send(res, status, payload) {
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  } catch {}
  res.end(JSON.stringify(payload));
}

async function readJson(req, maxBody) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBody) throw new Error('body-too-large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// 只接受局面字段。任何看起来像"经验文本"的字段都不读——否则客户端就能反过来把内容塞进提示词，
// 那就成了注入攻击的入口。
function readContext(value) {
  const context = {};
  const str = (input) => (typeof input === 'string' ? input.slice(0, 60).trim() : '');
  context.game = str(value?.game) || 'lol';
  context.champion = str(value?.champion);
  context.phase = str(value?.phase);
  context.dead = value?.dead === true;
  context.augments = Array.isArray(value?.augments) ? value.augments.slice(0, 3).map(str).filter(Boolean) : [];
  context.comps = Array.isArray(value?.comps) ? value.comps.slice(0, 3).map(str).filter(Boolean) : [];
  const patch = str(value?.patch);
  return { context, patch: patch || null };
}

export function createCoachInjectionHandler({
  library, authorize, advise, budgetChars = 400, maxItems = 6,
} = {}) {
  if (!library) throw new Error('injection handler needs the public library');
  if (typeof authorize !== 'function') throw new Error('injection handler needs an authorize function');
  if (typeof advise !== 'function') throw new Error('injection handler needs an advise function');

  return async function coachInjectionHandler(req, res) {
    const path = String(req?.url ?? '').split('?')[0];
    if (path !== PATH) return false;
    if (String(req?.method ?? '').toUpperCase() !== 'POST') {
      send(res, 405, { error: 'method-not-allowed' });
      return true;
    }
    let allowed = false;
    try { allowed = await authorize(req); } catch { allowed = false; }
    if (!allowed) { send(res, 401, { error: 'unauthorized' }); return true; }

    try {
      const { context, patch } = readContext(await readJson(req, MAX_BODY));
      const lessons = await library.query({
        game: context.game,
        patch,
        limit: 40,
      });
      const { section, used, dropped } = buildInjection({ lessons, context, patch, budgetChars, maxItems });
      const answer = await advise({ section, context, patch });
      // 响应只有建议与计数：没有任何一条经验原文，也没有内部字段。
      send(res, 200, {
        advice: String(answer?.advice ?? answer ?? '').slice(0, 2000),
        injected: used.length,
        dropped,
        tags: contextTags(context).length,
      });
      return true;
    } catch (error) {
      send(res, 400, { error: 'bad-request', reason: String(error?.message ?? 'invalid').slice(0, 60) });
      return true;
    }
  };
}
