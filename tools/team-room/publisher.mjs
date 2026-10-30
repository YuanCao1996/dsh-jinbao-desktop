import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)).digest('hex').slice(0, 24);
const nameOf = value => typeof value === 'string' ? value : value?.name ?? value?.displayName ?? value?.itemName;
const heroName = hero => hero?.champion ?? hero?.heroName;
const heroId = (hero, side = 'our') => `${side}-${hash(hero?.championAlias ?? hero?.championId ?? heroName(hero))}`;
const boundedInt = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max ? value : null;

// Projection is an allowlist. No raw logs, chat, screenshots, player identifiers,
// preferences or API credentials ever cross this boundary.
export function projectTeamFacts(facts, { deviceId, roomMatchId, nextVersion, now = Date.now() }) {
  if (!facts?.match || !['lol', 'wzry', 'generic'].includes(facts.game) || !Number.isFinite(facts.at)
    || now - facts.at > 30_000 || facts.at > now + 5000) return [];
  const packets = [], me = facts.me ?? {}, myName = heroName(me);
  const confirmedName = name => !facts.augmentRounds?.some(round => round.confirmationSource === 'countdown-default-confirmed' && round.confirmed?.includes(name));
  const push = (kind, payload) => packets.push({ schemaVersion: 1, deviceId, localMatchId: `local-${hash([facts.game, facts.match])}`,
    roomMatchId, stateVersion: nextVersion(), observedAt: Math.floor(facts.at), kind, payload });
  if (typeof myName === 'string' && myName.length > 0 && myName.length <= 80) {
    const items = Array.isArray(me.items) ? me.items.slice(0, 10).map(value => ({ id: `item-${hash(value?.id ?? value?.itemId ?? nameOf(value))}`,
      name: String(nameOf(value) ?? '未知装备').slice(0, 80), completed: value?.completed === true })).filter(item => item.name) : null;
    const selectedAugments = Array.isArray(facts.ownedAugments) ? facts.ownedAugments.slice(0, 10).map(value => ({
      id: `augment-${hash(nameOf(value))}`, name: String(nameOf(value) ?? '').slice(0, 80), confirmed: confirmedName(nameOf(value)),
    })).filter(augment => augment.name) : null;
    push('member_state', { heroId: heroId(me), heroName: myName, level: boundedInt(me.level, 1, 30),
      gold: boundedInt(me.gold, 0, 100_000), items, selectedAugments });
    const rounds = Array.isArray(facts.augmentRounds) ? facts.augmentRounds : [];
    const round = rounds.at(-1);
    if (round) {
      const offers = round.closed ? [] : (Array.isArray(facts.offers) ? facts.offers : []).map(nameOf).filter(value => typeof value === 'string' && value).slice(0, 3);
      push('augment_candidates', { heroId: heroId(me), roundId: `round-${hash(round.id)}`,
        candidates: offers.map(name => ({ id: `augment-${hash(name)}`, name: name.slice(0, 80) })) });
      if (Array.isArray(round.options) && Number.isFinite(facts.gameSeconds)) {
        const prompt = facts.confirmation?.round === round.id ? facts.confirmation : null;
        const names = (prompt?.options?.map(option => option.name) ?? round.options).filter(name => typeof name === 'string' && name).slice(0, 6);
        push('augment_round', { heroId: heroId(me), roundId: `round-${hash(round.id)}`, closed: round.closed === true,
          options: [...new Set(names)].map(name => ({ id: `augment-${hash(name)}`, name: name.slice(0, 80) })),
          localConfirmationId: prompt?.id ?? null, gameTimeSeconds: Math.max(0, Math.floor(facts.gameSeconds)) });
      }
    }
    for (const selectedRound of rounds) for (const name of selectedRound.confirmed ?? []) {
      if (typeof name !== 'string' || !name || !Number.isFinite(facts.gameSeconds)) continue;
      push('augment_selected', { heroId: heroId(me), roundId: `round-${hash(selectedRound.id)}`,
        augment: { id: `augment-${hash(name)}`, name: name.slice(0, 80), confirmed: selectedRound.confirmationSource !== 'countdown-default-confirmed' },
        gameTimeSeconds: Math.max(0, Math.floor(facts.gameSeconds)) });
    }
    for (const selectedRound of rounds) if (selectedRound.assumed && Number.isFinite(facts.gameSeconds)) {
      const name = String(selectedRound.assumed);
      push('augment_selected', { heroId: heroId(me), roundId: `round-${hash(selectedRound.id)}`,
        augment: { id: `augment-${hash(name)}`, name: name.slice(0, 80), confirmed: false }, gameTimeSeconds: Math.max(0, Math.floor(facts.gameSeconds)) });
    }
  }
  const all = [{ ...me, side: 'our' }, ...(facts.allies ?? []).map(hero => ({ ...hero, side: 'our' })),
    ...(facts.enemies ?? []).map(hero => ({ ...hero, side: 'enemy' }))];
  const heroes = [...new Map(all.filter(hero => typeof heroName(hero) === 'string' && heroName(hero)).map(hero =>
    [heroId(hero, hero.side), { heroId: heroId(hero, hero.side), heroName: heroName(hero).slice(0, 80), side: hero.side }])).values()].slice(0, 10);
  const ourKills = boundedInt(me.teamKills, 0, 1000), enemyKills = boundedInt(me.enemyKills, 0, 1000);
  if (Number.isFinite(facts.gameSeconds) && ourKills !== null && enemyKills !== null) {
    push('match_state', { gameTimeSeconds: Math.max(0, Math.floor(facts.gameSeconds)), ourKills, enemyKills, heroes,
      phase: facts.ended ? 'ended' : facts.phase === 'ChampSelect' ? 'select' : facts.phase === 'InProgress' ? 'playing' : 'loading' });
  }
  for (const event of (facts.completedEquipmentEvents ?? []).slice(-5)) {
    if (!Number.isFinite(event.at) || now - event.at > 20_000 || !Number.isFinite(event.time)) continue;
    const entity = all.find(hero => heroName(hero) === event.hero);
    if (!entity) continue;
    for (const name of event.items ?? []) {
      if (typeof name !== 'string' || !name) continue;
      push('equipment_completed', { heroId: heroId(entity, entity.side),
        item: { id: `item-${hash(name)}`, name: name.slice(0, 80), completed: true }, gameTimeSeconds: Math.max(0, Math.floor(event.time)) });
    }
  }
  return packets;
}

export function createTeamPublisher({ client, deviceId, getFacts, nextVersion, now = Date.now }) {
  const sent = new Map(); let scope;
  return {
    async tick({ room, binding }) {
      const facts = await getFacts();
      if (!facts || !room.currentMatch || binding?.roomMatchId !== room.currentMatch.id
        || binding.localMatch !== facts.match || binding.game !== facts.game
        || room.currentMatch.game !== facts.game) return { published: 0, state: 'binding_required' };
      const generation = JSON.stringify([room.id, room.currentMatch.id, room.membershipVersion]);
      if (generation !== scope) { sent.clear(); scope = generation; }
      const packets = projectTeamFacts(facts, { deviceId, roomMatchId: room.currentMatch.id, nextVersion, now: now() });
      let published = 0;
      for (const packet of packets) {
        const decision = { ...packet.payload };
        if (packet.kind === 'member_state') delete decision.gold;
        if (['augment_round', 'augment_selected'].includes(packet.kind)) delete decision.gameTimeSeconds;
        if (packet.kind === 'match_state') decision.gameTimeSeconds = Math.floor(decision.gameTimeSeconds / 10);
        const key = hash([room.id, packet.roomMatchId, packet.kind, decision]);
        // Unchanged state receives a low-frequency heartbeat for freshness;
        // repeated critical events are still deduplicated by the room service.
        const immutable = ['augment_selected', 'equipment_completed'].includes(packet.kind);
        const slot = immutable ? key : packet.kind, prior = sent.get(slot);
        if (prior?.key === key && (immutable || now() - prior.at < 10_000)) continue;
        await client.publish(room.id, packet); sent.set(slot, { key, at: now() }); published++;
        if (sent.size > 100) sent.delete(sent.keys().next().value);
      }
      return { published, state: packets.length ? 'sharing' : 'waiting_fresh_state' };
    },
    reset() { sent.clear(); scope = null; },
  };
}
