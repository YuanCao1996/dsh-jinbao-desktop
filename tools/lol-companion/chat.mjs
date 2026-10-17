// Shared existing game-chat parser; names and items are resolved through caller-provided local catalogs.


const TS_RE = /^\s*(\d{1,2}):(\d{2})\s*/;

const MUTATE_RE = /已质变\s*[:：]?\s*(.*)$/;

const PICKED_RE = /已选择了\s*(.*)$/;

const KILL_RE = /(?:击杀了|已终结了)/;

const BUY_RE = /购买了\s*(.+)$/;

const PING_RE = /示意|发出信号|请撤退|正在路上|注意/;

const CHAT_RE = /^(?:\[?\s*(?:队伍|小队|队|全体)\s*\]?[:：]?\s*)?([\s\S]*)$/;

const VERB_RE = /购买|售出|击杀|终结|选择|获得|使用|升级|已用|完成/;

const boxOf = (l) => {
  const b = l?.box;
  if (!Array.isArray(b) || !b.length) return null;
  const xs = b.map((p) => p[0]), ys = b.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
};

export const CHAT_AREA = { xMax: 830, yMin: 620, yMax: 980 };

export const AUG_NAME_X = [455, 600];

export function championSideDetailed(name, roster = {}) {
  if (!name) return { side: "unknown", inferred: false };
  const nameOf = (p) => (typeof p === "string" ? p : p?.champion);
  const eq = (a, b) => a && b &&
    (String(a) === String(b) || String(a).includes(String(b)) || String(b).includes(String(a)));
  const meName = nameOf(roster.me);
  const allies = (roster.allies ?? []).map(nameOf).filter(Boolean);
  const enemies = (roster.enemies ?? []).map(nameOf).filter(Boolean);
  const team = [...new Set([meName, ...allies].filter(Boolean).map(String))];
  if (eq(meName, name)) return { side: "me", inferred: false };
  if (team.some((c) => eq(c, name))) return { side: "ally", inferred: false };
  if (enemies.some((c) => eq(c, name))) return { side: "enemy", inferred: false };
  if (team.length >= 5) return { side: "enemy", inferred: true };
  return { side: "unknown", inferred: false };
}

export function championSide(name, roster = {}) {
  return championSideDetailed(name, roster).side;
}

export function mergeByY(lines, opts = {}) {
  const W = opts.width ?? 1920, H = opts.height ?? 1080;
  const sx = W / 1920, sy = H / 1080;
  const area = {
    xMax: CHAT_AREA.xMax * sx, yMin: CHAT_AREA.yMin * sy, yMax: CHAT_AREA.yMax * sy,
  };
  const inArea = [];
  for (const l of lines ?? []) {
    const b = boxOf(l);
    if (!b) continue;
    if (b.x > area.xMax || b.y < area.yMin || b.y > area.yMax) continue;
    const t = String(l.text ?? "").trim();
    if (!t) continue;
    inArea.push({ t, ...b, conf: l.score ?? 0 });
  }
  inArea.sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const it of inArea) {
    const yc = (it.y + it.y2) / 2;
    let row = rows.find((r) => Math.abs(r.yc - yc) <= 6 * sy);
    if (!row) { row = { yc, parts: [] }; rows.push(row); }
    row.parts.push(it);
  }
  for (const r of rows) {
    r.parts.sort((a, b) => a.x - b.x);
    r.text = r.parts.map((p) => p.t).join(" ").replace(/\s+/g, " ").trim();
    r.head = r.parts[0].t;
    r.tail = r.parts.length > 1 ? r.parts.slice(1).map((p) => p.t).join(" ") : "";
    const nameLo = AUG_NAME_X[0] * sx, nameHi = AUG_NAME_X[1] * sx;
    r.namePart = r.parts.filter((p) => p.x >= nameLo && p.x <= nameHi).map((p) => p.t).join(" ").trim();
    r.conf = Math.max(...r.parts.map((p) => p.conf));
    r.y = Math.min(...r.parts.map((p) => p.y));
  }
  rows.sort((a, b) => a.y - b.y);
  return rows;
}

function canonicalAugment(name, opts) {
  const lk = opts.augmentLookup;
  if (!name || typeof lk !== "function") return name;
  const hit = lk(name);
  if (typeof hit === "string") return hit;
  return hit?.name ?? name;
}

function augmentsIn(raw, opts, strict = false) {
  const t = String(raw ?? "");
  const fn = opts.augmentsInText;
  if (typeof fn === "function") {
    const list = fn(t);
    if (Array.isArray(list) && list.length) return list.filter(Boolean);
  }
  const t2 = cleanAug(t);
  if (!t2) return [];
  const lk = opts.augmentLookup;
  if (typeof lk === "function") {
    const hit = lk(t2);
    if (hit) return [typeof hit === "string" ? hit : (hit.name ?? t2)];
    const pfx = lk(`~prefix~${t2}`);
    if (pfx && typeof pfx === "string") return [pfx];
    const fix = lk(`~fix~${t2}`);
    if (fix && typeof fix === "string") return [fix];
  }
  if (strict) return [];
  const one = matchAugmentName(t2, opts.augmentLookup);
  return one ? [one] : [];
}

export function parseChat(lines, opts = {}) {
  const rows = mergeByY(lines, opts);
  const out = [];
  for (const r of rows) {
    const raw = r.text;
    let text = raw, time = null;
    const tm = TS_RE.exec(text);
    if (tm) { time = `${tm[1].padStart(2, "0")}:${tm[2]}`; text = text.slice(tm[0].length).trim(); }
    const stripped = stripPlayerNames(text, opts);

    const base = { time, text: raw, display: stripped.text, champions: stripped.champions, conf: r.conf, y: r.y };
    const head = r.head, tail = r.namePart || r.tail;
    const probe = text;
    const mu = MUTATE_RE.exec(head) ?? MUTATE_RE.exec(probe);
    if (mu) {
      const inline = augmentsIn(mu[1] ?? "", opts);
      const augs = inline.length ? inline : augmentsIn(tail, opts);
      const src = head.includes("已质变") ? head : probe;
      const norm = src.replace(/（/g, "(").replace(/）/g, ")");
      const afterParen = norm.includes(")") ? norm.slice(norm.lastIndexOf(")") + 1) : norm;
      const beforeMut = (/^(.*?)已质变/.exec(afterParen) ?? [])[1] ?? null;
      const cands = beforeMut && typeof opts.championsInText === "function" ? opts.championsInText(beforeMut) : [];
      let champ = cands.length ? cands[cands.length - 1] : null;
      if (!champ && beforeMut) {
        const cleaned = dedupeTail(beforeMut.replace(/^[\s:：;；,，、/\-]+|[\s:：;；,，、/\-]+$/g, "").trim());
        if (cleaned && !VERB_RE.test(cleaned) && !/[:：;；]/.test(cleaned)) {
          const fixed = opts.championFix ? opts.championFix(cleaned) : cleaned;
          champ = fixed && (!opts.isChampion || opts.isChampion(fixed)) ? fixed : null;
        }
      }
      const champFinal = champ || stripped.champions[0] || null;
      const augsCanon = augs.map((a) => canonicalAugment(a, opts));
      out.push({ ...base, kind: "augment_mutate", augment: augsCanon[0] ?? null, augments: augsCanon, champion: champFinal });
      continue;
    }
    const pk = PICKED_RE.exec(head) ?? PICKED_RE.exec(probe);
    if (pk) {
      const inline = augmentsIn(pk[1] ?? "", opts);
      const augs = (inline.length ? inline : augmentsIn(tail, opts)).map((a) => canonicalAugment(a, opts));
      out.push({ ...base, kind: "augment_picked_chat", augment: augs[0] ?? null, augments: augs, champion: stripped.champions[0] ?? null });
      continue;
    }
    const bu = BUY_RE.exec(probe);
    if (bu && !KILL_RE.test(probe)) {
      const rawItem = cleanItem(bu[1]);
      const r = resolveItem(rawItem, opts);
      out.push({
        ...base, kind: "purchase",
        item: r.name,
        itemRaw: rawItem,
        itemId: r.id ?? null,
        itemUnresolved: !r.name && !r.unchecked,
        champion: stripped.champions[0] ?? null,
      });
      continue;
    }
    if (KILL_RE.test(probe)) {
      let champs = stripped.champions;
      if (!champs.length && typeof opts.championsInText === "function") {
        champs = (opts.championsInText(probe) ?? [])
          .map((c) => ({ name: c?.name ?? String(c), at: probe.indexOf(c?.name ?? String(c)) }))
          .filter((x) => x.name && x.at >= 0)
          .sort((a, b) => a.at - b.at)
          .map((x) => x.name);
      }
      out.push({ ...base, kind: "kill", killer: champs[0] ?? null, victim: champs[1] ?? null });
      continue;
    }
    if (PING_RE.test(probe)) {
      out.push({ ...base, kind: "ping", champion: stripped.champions[0] ?? null });
      continue;
    }
    const ch = CHAT_RE.exec(text);
    const SEP = /[:：;；]/;
    if (time && ch && SEP.test(stripped.text)) {
      const sp = /^(.+?\([^)]+\))\s*[:：;；]\s*(.*)$/.exec(ch[1]);
      const dsp = stripped.text;
      const c0 = stripped.champions[0] ?? null;
      const content = (c0 && dsp.startsWith(c0)
        ? dsp.slice(c0.length).replace(/^\s*[:：;；]\s*/, "")
        : (sp ? sp[2] : ch[1])).trim();
      const names = augmentsIn(content, opts, true);
      const subject = (typeof opts.championsInText === "function" ? opts.championsInText(content) : []) ?? [];
      let owner = subject[0] ?? stripped.champions[0] ?? null;
      if (subject.length >= 2 && subject[0] === stripped.champions[0]) owner = subject[subject.length - 1];
      let rest = content;
      for (const n of names) rest = rest.replace(n, "");
      for (const c of subject) rest = rest.replace(c, "");
      rest = rest.replace(/[\s:：,，、/|]+/g, "").trim();
      if (names.length && rest.length <= 8 && !/[.!！?？;；]/.test(rest)) {
        out.push({
          ...base, kind: "augment_picked_chat",
          augment: names[0], augments: names,
          unresolved: rest || null,
          champion: owner, speakerChampion: stripped.champions[0] ?? null,
          source: "broadcast",
        });
        continue;
      }
      out.push({
        ...base, kind: "team_chat",
        speaker: sp ? sp[1] : null, content,
        champion: (typeof opts.championsInText === "function" ? opts.championsInText(content)[0] : null)
          ?? stripped.champions[0] ?? null,
        speakerChampion: stripped.champions[0] ?? null,
      });
      continue;
    }
    const adj = adjacentPairs(probe, opts);
    if (adj.pairs.length || adj.orphans.length) {
      const augments = [...new Set([...adj.pairs.map((p) => p.augment), ...adj.orphans])];
      out.push({
        ...base, kind: "augment_picked_chat",
        augment: adj.pairs[0]?.augment ?? adj.orphans[0],
        augments,
        champion: adj.pairs[0]?.champion ?? null,
        unattributed: adj.orphans.length ? adj.orphans : null,
        source: "broadcast_fragment",
      });
      continue;
    }
    if (!time && out.length && /^[^:：]{1,30}$/.test(text)) {
      const prev = out[out.length - 1];
      prev.text = `${prev.text} ${text}`;
      prev.continuation = true;
      continue;
    }
    out.push({ ...base, kind: "other" });
  }
  const DEDUP_KINDS = new Set(["augment_mutate", "augment_picked_chat", "purchase"]);
  const seenKey = new Set();
  return out.filter((m) => {
    if (!DEDUP_KINDS.has(m.kind)) return true;
    const k = `${m.kind}|${m.champion ?? ""}|${m.augment ?? m.item ?? m.itemRaw ?? ""}`;
    if (seenKey.has(k)) return false;
    seenKey.add(k);
    return true;
  });
}

const GAP_RE = /^[\s:：;；,，、|·)>）(（\[\]【】]*$/;
function adjacentPairs(text, opts) {
  const cf = opts.championsInText, af = opts.augmentsInText;
  if (typeof cf !== "function" || typeof af !== "function") return { pairs: [], orphans: [] };
  const t = String(text ?? "").replace(
    /(举报|常规配装|更多可选装|出售|撤销|商店|推荐|全部物品|配装方案|WeGame|在线|离线|好友列表)/g, "　");
  const champs = (cf(t) ?? []).map((n) => ({ n: String(n), i: t.indexOf(String(n)) })).filter((x) => x.i >= 0);
  const augs = (af(t) ?? []).map((n) => ({ n: String(n), i: t.indexOf(String(n)) })).filter((x) => x.i >= 0);
  const pairs = [], orphans = [];
  for (const a of augs) {
    const aEnd = a.i + a.n.length;
    let best = null;
    for (const c of champs) {
      const cEnd = c.i + c.n.length;
      const g1 = cEnd <= a.i ? t.slice(cEnd, a.i) : null;
      const g2 = aEnd <= c.i ? t.slice(aEnd, c.i) : null;
      const rank = g1 !== null && GAP_RE.test(g1)
        ? g1.length                                  // 前邻:距离越小越可信
        : g2 !== null && GAP_RE.test(g2) ? 1000 + g2.length : -1;
      if (rank < 0) continue;
      if (!best || rank < best.rank) best = { champion: c.n, rank };
    }
    if (best) pairs.push({ champion: best.champion, augment: a.n });
    else orphans.push(a.n);
  }
  return { pairs, orphans };
}

const UI_TAIL_RE = /(举报|常规配装|更多可选装|出售|撤销|商店|推荐|全部物品|配装方案|WeGame|在线|离线|离地|好友列表|切换交互|鼠标穿透|技能分配|额外悬赏|悬赏)+$/g;

function cleanAug(s) {
  let t = String(s ?? "")
    .replace(/^[)\）：:;；,，、>\s]+/, "")
    .replace(/[。.!！\s]+$/, "")
    .trim();
  let prev = null;
  while (prev !== t) { prev = t; t = t.replace(UI_TAIL_RE, "").trim(); }
  return t;
}

export function matchAugmentName(raw, lookup) {
  const t = cleanAug(raw);
  if (!t) return null;
  const lk = typeof lookup === "function" ? lookup : null;
  if (!lk) return t;
  if (lk(t)) return t;                                     // ① 精确
  const cand = lk(`~prefix~${t}`);                         // ② 唯一前缀补全
  if (cand && typeof cand === "string") return cand;
  return t;
}

function cleanItem(s) {
  const t = String(s ?? "").split(/[\s\d|★]+/)[0] ?? "";
  return t.replace(/[。.!！,，、;；:：]+$/, "").trim();
}

function resolveItem(raw, opts) {
  const t = String(raw ?? "").trim();
  if (!t) return { name: null };
  const lk = opts.itemLookup;
  if (typeof lk !== "function") return { name: null, unchecked: true };
  const exact = lk(t);
  if (exact) return { name: exact.name ?? t, id: exact.id ?? null };
  const pfx = lk(`~prefix~${t}`);
  if (pfx && typeof pfx === "string") return { name: pfx, id: lk(pfx)?.id ?? null, repaired: "prefix" };
  const fix = lk(`~fix~${t}`);
  if (fix && typeof fix === "string") return { name: fix, id: lk(fix)?.id ?? null, repaired: "fix" };
  return { name: null };
}

function dedupeTail(s) {
  const t = String(s ?? "").replace(/\s+/g, "");
  let out = t.replace(/(.)\1+/g, "$1");
  out = out.replace(/(..)\1+/g, "$1");
  return out;
}

export function augmentPicks(msgs) {
  return msgs
    .filter((m) => (m.kind === "augment_mutate" || m.kind === "augment_picked_chat") && m.augment)
    .map((m) => ({ augment: m.augment, champion: m.champion ?? null, time: m.time, kind: m.kind, conf: m.conf }));
}
const NAME_CHAMP_RE = /([^()（）\s:：]{1,24})\s*[（(]\s*([^()（）\s]{2,12})\s*[)）]/g;
const CHAMP_PAREN_RE = /[（(]?\s*([^()（）\s]{2,12})\s*[)）]/g;

function championResolve(raw, opts) {
  if (!raw) return null;
  const isC = opts.isChampion;
  if (!isC) return null;
  if (isC(raw)) return raw;
  const fixed = opts.championFix?.(raw);
  return fixed && fixed !== raw && isC(fixed) ? fixed : null;
}

const CJK_OR_WORD = /[\u4e00-\u9fa5A-Za-z0-9]/;

const NAME_VERB_TAIL_RE = /^(.*?(?:击杀了|已终结了|购买了|售出|示意|完成了|完成|选择了|选择|获得了|获得|使用了|使用|升级|终结))([\s\S]+)$/;
const splitMessage = (name) => {
  const m = NAME_VERB_TAIL_RE.exec(name);
  return m ? m[1] : null;             // 返回要保留的正文前缀
};

export function stripPlayerNames(text, opts = {}) {
  const s = String(text ?? "");
  const champions = [];
  const keep = (c, whole, offset, after, namePart) => {
    champions.push(c);
    const tail = CJK_OR_WORD.test(after ?? "") ? `${c} ` : c;
    const prefix = namePart ? splitMessage(namePart) : null;
    return prefix ? `${prefix}${tail}` : tail;
  };
  let out = s.replace(NAME_CHAMP_RE, (whole, name, champ, offset) => {
    const c = championResolve(champ, opts);
    if (!c) return whole;
    return keep(c, whole, offset, s[offset + whole.length], name);
  });
  out = out.replace(CHAMP_PAREN_RE, (whole, champ, offset) => {
    const c = championResolve(champ, opts);
    if (!c) return whole;
    if (whole.startsWith(")") && champions.includes(c)) return whole;   // ① 已处理过
    if (champions.includes(c) && !whole.includes("(") && !whole.includes("（")) return whole;
    return keep(c, whole, offset, s[offset + whole.length], null);
  });
  if (champions.length) {
    const lead = out.indexOf(champions[0]);
    if (lead > 0) out = out.slice(lead);
  }
  return { text: out.replace(/\s+/g, " ").trim(), champions };
}

export const SIDE_CN = { me: "自己", ally: "我方", enemy: "敌方", unknown: "待定" };

export function ownedAugmentsText(rows) {
  const list = (rows ?? []).filter((r) => r && (r.augments ?? []).length);
  if (!list.length) {
    return [
      "本局已获取强化",
      "  还没读到强化播报。",
      "  强化名只在局内播报里出现几秒(OCR 才读得到),",
      "  没读到 ≠ 没人拿。",
    ].join("\n");
  }
  const total = list.reduce((n, r) => n + r.augments.length, 0);
  const L = [`本局已获取强化(局内播报 OCR · ${list.length} 人 / ${total} 条)`];
  for (const side of ["me", "ally", "enemy", "unknown"]) {
    for (const r of list.filter((x) => (x.side ?? "unknown") === side)) {
      const who = r.title || r.champion || "?";
      L.push(`${SIDE_CN[side]} ${who}${r.sideInferred ? "(推断)" : ""}: ${r.augments.join("、")}`);
    }
  }
  if (list.every((r) => (r.side ?? "unknown") === "unknown")) {
    L.push("(阵营待定:我方名单还没凑齐,齐了会自动分敌我)");
  }
  return L.join("\n");
}

export function chatToText(msgs, limit = 12) {
  if (!msgs?.length) return "";
  const L = ["【局内聊天/事件栏】"];
  for (const m of msgs.slice(-limit)) {
    const t = m.time ? `${m.time} ` : "";
    const body = (m.display ?? m.text ?? "").replace(TS_RE, "").trim();
    if (m.kind === "augment_mutate") L.push(`  ${t}${m.champion ? `${m.champion} ` : ""}已质变: ${m.augment || "(名字未读出)"}`);
    else if (m.kind === "augment_picked_chat") L.push(`  ${t}${m.champion ? `${m.champion} ` : ""}已选择强化: ${m.augment || "(名字未读出)"}`);
    else if (m.kind === "purchase") {
      const nm = m.item ?? (m.itemUnresolved ? "(名字未读出)" : (m.itemRaw ?? ""));
      L.push(`  ${t}购买: ${nm}`);
    }
    else if (m.kind === "team_chat") L.push(`  ${t}${m.champion ?? m.speaker ?? ""}: ${m.content ?? ""}`);
    else if (!m.continuation) L.push(`  ${t}${body}`);
  }
  return L.join("\n");
}
