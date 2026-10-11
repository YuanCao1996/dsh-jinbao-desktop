const clean = value => typeof value === 'string' && !/^(未确认|未知|暂无|无|—|-)$/.test(value.trim()) ? value.trim().slice(0, 120) : '';
export function elapsedSeconds(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,3}):([0-5]\d)$/.exec(value.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}
const roster = value => Array.isArray(value) ? value.map(player => typeof player === 'string'
  ? { champion: clean(player) }
  : { champion: clean(player?.hero), name: clean(player?.name), lane: clean(player?.lane) }).filter(player => player.champion || player.name) : undefined;
const known = value => Object.fromEntries(Object.entries(value).filter(([, field]) => field !== ''));

// Only extract documented game-clock and identity fields. OCR numbers and log timestamps
// are never interpreted as elapsed match time.
export function projectWzryFacts(event) {
  if (event?.kind === 'match_start') return { kind: 'match_start', phase: 'Pregame' };
  if (event?.kind === 'match_end') return { kind: 'event', name: 'GameEnd', outcome: event.outcome };
  if (event?.kind === 'broadcast') return { kind: 'broadcast', broadcast: event.text };
  if (event?.kind === 'interaction' && event.context) {
    const context = event.context;
    const state = { time: elapsedSeconds(context.game_time) };
    const me = known({ champion: clean(context.self?.hero), name: clean(context.self?.name), lane: clean(context.self?.lane) });
    if (state.time === null && !me.champion) return null;
    return { kind: 'state', state, me, allies: roster(context.our_team), enemies: roster(context.enemy_team) };
  }
  if (event?.kind !== 'brief') return null;
  const brief = String(event.text ?? '');
  const time = elapsedSeconds(brief.match(/(?:^|\n)\s*-?\s*对局时间[：:]\s*([^\n]+)/)?.[1]);
  const identity = brief.match(/(?:^|\n)\s*-?\s*本人[：:]\s*玩家=([^；\n]*)；英雄=([^；\n]*)；分路=([^\n]*)/);
  const me = identity ? known({ name: clean(identity[1]), champion: clean(identity[2]), lane: clean(identity[3]) }) : {};
  const kda = brief.match(/(?:^|\n)\s*-?\s*本人KDA[：:]\s*(\d+)\/(\d+)\/(\d+)/);
  if (kda) Object.assign(me, { k: Number(kda[1]), d: Number(kda[2]), a: Number(kda[3]) });
  const gold=brief.match(/(?:^|\n)\s*-?\s*本人经济[：:]\s*(\d+)\s*(?:\n|$)/);
  if(gold)me.gold=Number(gold[1]);
  const team = side => {
    const line = brief.match(new RegExp('(?:^|\\n)\\s*-?\\s*' + side + '阵容[：:]\\s*([^\\n]*)'))?.[1];
    if (!line || !clean(line)) return undefined;
    let value;
    try { value = JSON.parse(line); } catch { value = line.split(/[、,，]/).map(item => item.trim()); }
    return roster(value);
  };
  if (time === null && !me.champion) return null;
  return { kind: 'state', state: { time }, me, allies: team('我方'), enemies: team('敌方') };
}
