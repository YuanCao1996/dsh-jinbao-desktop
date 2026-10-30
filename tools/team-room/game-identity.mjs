import { readCredentials } from '../lol-companion/lockfile.mjs';
import { lcuRequest } from '../lol-companion/lcu.mjs';

// Optional read-only identity evidence. Missing or inconsistent evidence never
// falls back to equating two games by elapsed time, nickname or IP address.
export function createGameIdentity({ credentials = readCredentials, request = lcuRequest, now = Date.now } = {}) {
  let last = -Infinity, cached = null, sourceKey = null;
  return async facts => {
    if (facts?.game !== 'lol' || facts.ended || !['ChampSelect', 'InProgress'].includes(facts.phase)) return null;
    const key = `${facts.match}:${facts.phase}`;
    if (sourceKey !== key) { sourceKey = key; last = -Infinity; cached = null; }
    if (now() - last < 5000) return cached;
    last = now(); cached = null;
    try {
      const auth = credentials(); if (!auth.ok) return null;
      const response = await request(auth, '/lol-gameflow/v1/session', { timeoutMs: 2000 });
      const data = response.data, gameId = data?.gameData?.gameId;
      if (response.status !== 200 || !Number.isSafeInteger(gameId) || gameId < 1
        || !['ChampSelect', 'InProgress', 'Reconnect'].includes(data.phase)) return null;
      if (facts.phase === 'InProgress' && data.phase === 'ChampSelect') return null;
      cached = { matchKey: `lol-${gameId}`, observedAt: now() }; return cached;
    } catch { return null; }
  };
}
