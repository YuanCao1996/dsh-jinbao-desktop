import { mkdir, readdir, readFile, writeFile, rename, appendFile, open, realpath } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const validGame = game => ['lol', 'wzry', 'generic'].includes(game);
const privateKey = /authorization|cookie|token|secret|password|api[_-]?key|puuid|riotId|summonerName|playerName|openid|unionid/i;
// Preserve observations as data, never expose credentials or player identifiers to tools.
export function cleanGameData(value, depth = 0) {
  if (depth > 12) return null;
  if (typeof value === 'string') return value.replace(/\bj[cdw]_[a-f0-9]{64}\b|\bBearer\s+[A-Za-z0-9._-]+|\bsk-[A-Za-z0-9_-]{16,}\b/gi, '[凭据已隐藏]').slice(0, 8000);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.slice(0, 200).map(item => cleanGameData(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !privateKey.test(key)).slice(0, 100).map(([key, item]) => [key, cleanGameData(item, depth + 1)]));
  return null;
}

export function createGameMemory(stateDir) {
  const root = join(stateDir, 'game-memory');
  let queue = Promise.resolve();
  const snapshots = new Map();
  let cursors;
  const ordered = action => { const task = queue.then(action); queue = task.catch(() => {}); return task; };
  const id = (game, match) => {
    if (!validGame(game) || typeof match !== 'string' || !match || match.length > 300) throw Error('Invalid game or match');
    return hash(game + ':' + match);
  };
  async function atomic(file, value) {
    await mkdir(root, { recursive: true });
    await writeFile(file + '.tmp', JSON.stringify(value), { mode: 0o600 });
    await rename(file + '.tmp', file);
  }
  async function load(game, match) {
    try { return JSON.parse(await readFile(join(root, id(game, match) + '.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function preferences(game) {
    try { const value = JSON.parse(await readFile(join(root, 'preferences-' + game + '.json'), 'utf8')); return Array.isArray(value) ? value : []; }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async function history(game, match, limit = 6, cursor = 0, query = '') {
    if (!validGame(game) || !Number.isInteger(limit) || limit < 1 || limit > 20 || !Number.isSafeInteger(cursor) || cursor < 0 || typeof query !== 'string' || query.length > 200) throw Error('Invalid memory query');
    await queue;
    let files; try { files = await readdir(root); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const rows = [];
    for (const name of files.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      try { const row = JSON.parse(await readFile(join(root, name), 'utf8')); if (row.game === game && row.match !== match) rows.push(row); } catch {}
    }
    return rows.sort((a, b) => b.at - a.at).filter(row => !query || JSON.stringify(row).includes(query)).slice(cursor, cursor + limit).map(row => ({
      game: row.game, mode: row.mode, match: row.match, champion: row.me?.champion, ended: row.ended,
      durationSeconds: row.gameSeconds, at: row.at, ownedAugments: row.ownedAugments,
      items: row.me?.items, events: row.events?.slice(-8), chat: row.chat?.slice(-4), broadcasts: row.broadcasts?.slice(-2),
    }));
  }
  async function sourceQuery({ game, source, cursor = 0, query = '', limit = 20 }) {
    if (!validGame(game) || !Number.isSafeInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 40 || typeof query !== 'string' || query.length > 200) throw Error('Invalid source query');
    const logs = await realpath(join(stateDir, 'logs'));
    if (source === '__list__') return { sources: (await readdir(logs)).filter(name => name.endsWith('.jsonl')).slice(-100), note: '原始日志可能覆盖多局；没有 match 字段的记录不能推定为当前局。' };
    if (typeof source !== 'string' || basename(source) !== source || /[\\/:]/.test(source) || !source.endsWith('.jsonl')) throw Error('Invalid log source');
    const file = await realpath(join(logs, source));
    if (dirname(file) !== logs) throw Error('Log source escapes logs directory');
    const handle = await open(file, 'r');
    try {
      const { size } = await handle.stat();
      if (cursor > size) throw Error('Invalid source cursor');
      if (cursor) { const byte = Buffer.alloc(1); await handle.read(byte, 0, 1, cursor - 1); if (byte[0] !== 10) throw Error('Cursor must be a record boundary'); }
      const buffer = Buffer.alloc(Math.min(size - cursor, 1024 * 1024));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, cursor);
      const rows = []; let used = 0, chars = 0;
      while (used < bytesRead) {
        const end = buffer.indexOf(10, used); if (end < 0) break;
        const line = buffer.subarray(used, end).toString('utf8');
        let raw; try { raw = JSON.parse(line); } catch { used = end + 1; continue; }
        const belongs = !raw.game || raw.game === game;
        if (belongs && (!query || line.includes(query))) {
          const row = cleanGameData(raw), encoded = JSON.stringify(row);
          if (chars + encoded.length > 24000 && rows.length) break;
          rows.push(encoded.length > 24000 ? { oversized: true, kind: raw.kind, message: '原始单条记录过大，请在本机日志查看。' } : row);
          chars += encoded.length;
        }
        used = end + 1;
        if (rows.length >= limit) break;
      }
      if (!used && bytesRead && buffer.indexOf(10) < 0) throw Error('原始单条日志超过 1MB，请在本机日志文件查看。');
      return { source, historicalRaw: true, note: '原始日志中缺少对局标识的内容不得当作当前局事实。', rows, nextCursor: cursor + used < size ? cursor + used : null };
    } finally { await handle.close(); }
  }
  return {
    record(state, event, source, position) {
      if (!state?.game || !state.match) return Promise.resolve();
      const key = id(state.game, state.match);
      const row = cleanGameData({ game: state.game, match: state.match, source, event });
      const encoded = JSON.stringify(row);
      // Original source logs remain intact; an oversize observation is explicitly marked.
      const line = Buffer.byteLength(encoded) <= 240000 ? encoded : JSON.stringify({ game: state.game, match: state.match, source, oversized: true, kind: event.kind });
      return ordered(async () => {
        await mkdir(root, { recursive: true });
        if (!cursors) { try { cursors = JSON.parse(await readFile(join(root, 'ingest.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; cursors = {}; } }
        if (position && (cursors[position.key] ?? 0) >= position.offset) return;
        await appendFile(join(root, key + '.jsonl'), line + '\n', { mode: 0o600 });
        if (position) cursors[position.key] = position.offset;
      });
    },
    snapshot(state, knowledge = []) {
      if (!state?.game || !state.match) return Promise.resolve();
      const key = id(state.game, state.match);
      const value = cleanGameData({ game: state.game, mode: state.mode, match: state.match, at: state.at, matchStartedAt: state.matchStartedAt,
        gameSeconds: state.gameSeconds, ended: state.ended, phase: state.phase, me: state.me,
        allies: state.allies, enemies: state.enemies, bench: state.bench, offers: state.offers,
        offerHistory: state.offerHistory, ownedAugments: state.ownedAugments, augmentRounds:state.augmentRounds,
        events: state.events, broadcasts: state.broadcasts, chat: state.chat, knowledge });
      const encoded = JSON.stringify(value);
      if (snapshots.get(key) === encoded) return queue;
      return ordered(async () => {
        const previous = await load(value.game, value.match);
        if (previous && previous.at > value.at) return;
        // Replaying observation logs does not replay user chat messages. Keep the
        // persisted conversation until live chat explicitly supplies its history.
        if (!value.chat?.length && previous?.chat?.length) value.chat = previous.chat;
        await atomic(join(root, key + '.json'), value);
        snapshots.set(key, encoded);
        if (snapshots.size > 64) snapshots.delete(snapshots.keys().next().value);
      });
    },
    async currentFacts(game, match) {
      await queue;
      const [current, saved] = await Promise.all([load(game, match), preferences(game)]);
      return { current, preferences: saved.slice(-6).map(row => ({ fact: row.fact, at: row.at, origin: row.origin })) };
    },
    async context(game, match) {
      await queue;
      const [current, saved] = await Promise.all([load(game, match), preferences(game)]);
      const result = { current, previousMatches: [], preferences: saved.slice(-12).map(row => ({ fact: row.fact, at: row.at, origin: row.origin })), historyAvailableVia: 'game_log_query / game_memory_query (only when user requests past matches)' };
      // Keep valid JSON; reduce whole fields rather than cutting serialized text in half.
      while (JSON.stringify(result).length > 16000 && result.previousMatches.length) result.previousMatches.pop();
      if (current && JSON.stringify(result).length > 16000) {
        result.current = { game, mode: current.mode, match, phase: current.phase, gameSeconds: current.gameSeconds, me: current.me,
          allies: current.allies, enemies: current.enemies, bench: current.phase === 'ChampSelect' ? current.bench : [],
          augmentRounds: current.augmentRounds, ended: current.ended,
          offers: current.offers, ownedAugments: current.ownedAugments, events: current.events?.slice(-12),
          broadcasts: current.broadcasts?.slice(-3), chat: current.chat?.slice(-4), contextReduced: true };
      }
      if (JSON.stringify(result).length > 16000) result.current = { game, mode: current?.mode, match, champion: current?.me?.champion,
        events:current?.events?.slice(-8).map(e=>({time:e.time,text:String(e.text??'').slice(0,240)})),ownedAugments:current?.ownedAugments?.slice(-12),contextReduced: true };
      return result;
    },
    history,
    preferences,
    async query({ game, match, source, cursor = 0, query = '', kind = '', limit = 20 }) {
      if (source) return sourceQuery({ game, source, cursor, query, limit });
      await queue;
      if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 40 || typeof query !== 'string' || query.length > 200) throw Error('Invalid log query');
      const file = join(root, id(game, match) + '.jsonl');
      let handle; try { handle = await open(file, 'r'); } catch (error) { if (error.code === 'ENOENT') return { rows: [], nextCursor: null }; throw error; }
      try {
        const { size } = await handle.stat();
        if (cursor > size) throw Error('Invalid cursor');
        if (cursor) { const previous = Buffer.alloc(1); await handle.read(previous, 0, 1, cursor - 1); if (previous[0] !== 10) throw Error('Cursor must be a record boundary'); }
        const buffer = Buffer.alloc(Math.min(size - cursor, 512 * 1024));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, cursor);
        const rows = []; let used = 0, chars = 0;
        while (used < bytesRead) {
          const end = buffer.indexOf(10, used); if (end < 0) break;
          const line = buffer.subarray(used, end).toString('utf8');
          const row = JSON.parse(line);
          const matches = (!query || line.toLowerCase().includes(query.toLowerCase())) && (!kind || row.event?.kind === kind ||
            (row.event?.kind === 'chat_events' && Array.isArray(row.event.events) && row.event.events.some(event => event?.kind === kind)));
          if (matches && chars + line.length > 24000 && rows.length) break;
          used = end + 1;
          if (matches) {
            if (line.length > 24000) rows.push({ source: row.source, oversized: true, kind: row.event?.kind, message: '单条记录过大，请在本机原始日志查看。' });
            else { rows.push(row); chars += line.length; }
          }
          if (rows.length >= limit) break;
        }
        return { game, match, rows, nextCursor: cursor + used < size ? cursor + used : null };
      } finally { await handle.close(); }
    },
    async remember(game, fact, quote, question) {
      if (!validGame(game) || typeof fact !== 'string' || !fact.trim() || fact.length > 500 || typeof quote !== 'string' || quote.length < 2 || !question?.includes(quote)) throw Error('Memory requires an explicit statement in the current user question');
      return ordered(async () => {
        const rows = await preferences(game);
        if (!rows.some(row => row.fact === fact)) rows.push({ fact, quote, at: Date.now(), origin: 'user' });
        await atomic(join(root, 'preferences-' + game + '.json'), rows.slice(-30));
        return { ok: true };
      });
    },
    flush: () => ordered(async () => { if (cursors) await atomic(join(root, 'ingest.json'), cursors); }),
  };
}
