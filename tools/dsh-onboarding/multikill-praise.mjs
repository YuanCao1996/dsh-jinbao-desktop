// Differentiated, immediate praise for multi-kills.
//
// Deterministic on purpose: a model round-trip lands seconds later, after the moment
// has passed, and praise must never invent facts about the fight. Texts stay short so
// they survive the speech pipeline's 60-character single-segment rule.
//
// A multi-kill arrives as a chain of Multikill events (2 -> 3 -> 4 -> 5) a few seconds
// apart, so each chain settles briefly after its last kill and is praised once at its
// real level. The local player is praised from 2 kills; teammates only for quadra and
// penta, because doubling on every ally double kill would be noise.
//
// Tone follows the mentor the player actually selected (金宝/柳如风/王霸天/铁汁).

export const PRAISE_MAX_STREAK = 5;
export const ALLY_MIN_STREAK = 4;
export const PRAISE_CHAIN_MS = 10_000;
export const PRAISE_SETTLE_MS = 2_000;
export const PRAISE_MAX_WAIT_MS = 12_000;
export const PRAISE_ROLES = Object.freeze(['jinbao', 'liurufeng', 'wangbatian', 'tiezhi']);

const SELF = {
  jinbao: {
    2: ['双杀，稳住这个节奏。', '双杀到手，继续压。'],
    3: ['三杀！手感回来了，接着打。', '三杀！这波很漂亮。'],
    4: ['四杀！最后一个也拿下！', '四杀！再来一个就是五杀！'],
    5: ['五杀！这波太漂亮了！', '五杀！记住这一波。'],
  },
  liurufeng: {
    2: ['双杀，节奏正确。', '双杀，保持推进。'],
    3: ['三杀。继续保持这个走位。', '三杀，优势已经建立。'],
    4: ['四杀。收掉最后一个。', '四杀，再一个就是五杀。'],
    5: ['五杀。这一波可以回放了。', '五杀，执行力满分。'],
  },
  wangbatian: {
    2: ['双杀！就该这么打。', '双杀，跟我压。'],
    3: ['三杀！这才是我的队友。', '三杀，别给他们喘息。'],
    4: ['四杀！最后一个也别放过！', '四杀！再来一个满贯！'],
    5: ['五杀！全场都是你的！', '五杀！这才叫统治。'],
  },
  tiezhi: {
    2: ['双杀，对面有点懵了。', '双杀，这波挺顺手。'],
    3: ['三杀！对面指挥都乱了。', '三杀，这波我服。'],
    4: ['四杀！就差一个凑数了。', '四杀，对面已经不想玩了。'],
    5: ['五杀！这波我得给你鼓掌。', '五杀！对面直接不吭声了。'],
  },
};

const ALLY = {
  jinbao: {
    4: ['{hero}四杀！跟着冲。', '{hero}四杀，快接上。'],
    5: ['{hero}五杀！太漂亮了。', '{hero}五杀，这波稳了。'],
  },
  liurufeng: {
    4: ['{hero}四杀，抓住这个窗口。', '{hero}四杀，可以推进。'],
    5: ['{hero}五杀，节奏完全在我们手里。', '{hero}五杀，跟着收尾。'],
  },
  wangbatian: {
    4: ['{hero}四杀！上去压。', '{hero}四杀，一口气打穿。'],
    5: ['{hero}五杀！给我推。', '{hero}五杀，直接结束这局。'],
  },
  tiezhi: {
    4: ['{hero}四杀，就差一个凑整。', '{hero}四杀，对面不敢上了。'],
    5: ['{hero}五杀，这波可以吹一年。', '{hero}五杀，对面怕是说不出话了。'],
  },
};

const pickOf = (list, pick) => {
  const index = Number.isInteger(pick) ? ((pick % list.length) + list.length) % list.length : 0;
  return list[index];
};

export function praiseText({ streak, side = 'self', role = 'jinbao', hero = '', pick = 0 } = {}) {
  const byRole = (side === 'ally' ? ALLY : SELF);
  const table = byRole[role] ?? byRole.jinbao;
  const list = table?.[streak];
  if (!list || !list.length) return '';
  const raw = pickOf(list, pick);
  if (side !== 'ally') return raw;
  const name = String(hero ?? '').trim().slice(0, 12);
  return name ? raw.replace('{hero}', name) : raw.replace(/\{hero\}/g, '').trim();
}

// Names we accept for one participant. The live client reports riotId ("名字#tag") or
// summonerName, China-server summonerName is usually empty, and event KillerName comes
// WITHOUT the tag, so every non-empty form is kept with and without the tag.
function identities(person) {
  const out = new Set();
  for (const value of [person?.name, person?.riotId, person?.summonerName]) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    out.add(trimmed);
    const bare = trimmed.replace(/#.*$/, '').trim();
    if (bare) out.add(bare);
  }
  return out;
}

function matched(person, killer) {
  const mine = identities(person);
  if (!mine.size) return false;
  if (mine.has(killer)) return true;
  const bare = killer.replace(/#.*$/, '').trim();
  return !!bare && mine.has(bare);
}

// side: 'self' | 'ally' | 'other'  (unknown/absent killer stays 'other')
export function whoKilled(state, event) {
  const killer = String(event?.killer ?? event?.KillerName ?? '').trim();
  if (!killer) return { side: 'other' };
  if (matched(state?.me, killer)) return { side: 'self' };
  for (const ally of state?.allies ?? []) {
    if (matched(ally, killer)) return { side: 'ally', hero: String(ally?.champion ?? '') };
  }
  return { side: 'other' };
}

const chainKey = (side, hero) => (side === 'ally' ? `ally:${String(hero ?? '')}` : 'self');

export function recordMultikill(state, { streak, side = 'self', hero = '', at, now } = {}) {
  const level = Number(streak);
  const minimum = side === 'ally' ? ALLY_MIN_STREAK : 2;
  if (!Number.isInteger(level) || level < minimum || level > PRAISE_MAX_STREAK) return false;
  if (side !== 'self' && side !== 'ally') return false;
  const stamp = Number.isFinite(at) ? at : now;
  if (!Number.isFinite(stamp)) return false;
  const chains = state.praiseChains ?? (state.praiseChains = {});
  const key = chainKey(side, hero);
  const prior = chains[key];
  const sameChain = !!prior && Math.abs(stamp - prior.lastAt) <= PRAISE_CHAIN_MS;
  if (sameChain && level < prior.streak) return false; // never downgrade a chain
  chains[key] = {
    key, side, hero, chainAt: sameChain ? prior.chainAt : stamp, lastAt: stamp,
    streak: level,
    // One praise per chain: an escalating 2 -> 3 -> 4 must not become three utterances.
    // The settle delay already waits for the chain's real final level.
    settled: sameChain ? prior.settled === true : false,
    variant: (prior?.variant ?? -1) + 1,
  };
  return true;
}

// Emit every chain that has gone quiet. Safe to call on each poll tick.
export function settlePraise(state, now = Date.now(), {
  settleMs = PRAISE_SETTLE_MS, maxWaitMs = PRAISE_MAX_WAIT_MS, role = 'jinbao',
} = {}) {
  const chains = state?.praiseChains;
  if (!chains) return false;
  let emitted = false;
  for (const chain of Object.values(chains)) {
    if (!chain || chain.settled) continue;
    const quiet = now - chain.lastAt >= settleMs;
    const stalled = now - chain.chainAt >= maxWaitMs;
    if (!quiet && !stalled) continue;
    const text = praiseText({ streak: chain.streak, side: chain.side, role, hero: chain.hero, pick: chain.variant });
    if (!text) continue;
    const id = `${chain.key}@${chain.chainAt}`;
    state.broadcasts = (state.broadcasts ?? []).filter(reply => reply.praiseChain !== id);
    state.broadcasts.push({
      at: Number.isFinite(chain.lastAt) ? chain.lastAt : now,
      text, priority: 2, praise: true, praiseChain: id, praiseSide: chain.side,
      praiseHero: chain.side === 'ally' ? chain.hero : '', streak: chain.streak,
      variant: chain.variant, expiresAt: now + 12_000,
    });
    state.broadcasts = state.broadcasts.slice(-12);
    chain.settled = true;
    emitted = true;
  }
  return emitted;
}

export function resetPraise(state) {
  if (state) state.praiseChains = {};
}
