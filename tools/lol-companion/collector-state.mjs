import { lcuRequest } from './lcu.mjs';
import { createPlayerStats, buildRows } from './player-stats.mjs';

export function stateEvent(state) {
  return { kind: 'state', mode: state.mode, me: state.me, allies: state.allies, enemies: state.enemies,
    state: { ...state.me, time: state.gameTime, hpPct: state.me.maxHp ? state.me.hp / state.me.maxHp : null,
      teamKills: state.allies.reduce((n, p) => n + (p.k ?? 0), 0),
      enemyKills: state.enemies.reduce((n, p) => n + (p.k ?? 0), 0),
      enemyItems: state.enemies.flatMap(p => p.items ?? []) } };
}
export function createRosterStats(getCredentials, request = lcuRequest) {
  const identities = new Map();
  const stats = createPlayerStats({ request: async path => {
    const credentials = getCredentials();
    if (!credentials.ok) return { status: 503 };
    return request(credentials, path);
  } });
  return async function lookup(state) {
    const players = [...state.allies.map(p => ({ ...p, team: 'ally' })), ...state.enemies.map(p => ({ ...p, team: 'enemy' }))];
    for (const player of players) {
      if (!player.puuid && player.riotId) {
        if (identities.has(player.riotId)) player.puuid = identities.get(player.riotId);
        else {
          const credentials = getCredentials();
          if (credentials.ok) try {
            const result = await request(credentials, '/lol-summoner/v1/summoners?name=' + encodeURIComponent(player.riotId));
            if (result.status === 200 && result.data?.puuid) {
              player.puuid = result.data.puuid; identities.set(player.riotId, player.puuid);
            }
          } catch {}
        }
      }
    }
    const found = new Map((await stats.lookupMany(players.map(p => p.puuid).filter(Boolean))).map(s => [s.puuid, s]));
    const mePuuid=state.me.puuid??players.find(p=>p.riotId&&p.riotId===state.me.riotId)?.puuid;
    const rows = buildRows(players, found, { mePuuid });
    for (const row of rows) if (!row.puuid) row.error = '客户端暂未提供可查询的玩家身份';
    return { kind: 'player_stats', rows, queried: players.length, got: rows.filter(r => !r.error && r.winRate !== null).length };
  };
}
