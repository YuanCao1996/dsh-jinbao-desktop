// agent 修订经验的唯一入口。
//
// 两条硬规则，写在代码里而不是提示词里：
//   1. 只能改私有经验——公有是所有人的，agent 私自改就等于绕过 3 账号验证；
//   2. 必须给出理由，并作为 edited-by:agent 落库，事后能查是谁、为什么改的。

const PRIVATE_KINDS = new Set(['preference', 'correction', 'stats', 'pitfall', 'style']);
const MAX_REASON = 200;

export function createExperienceEditor({ store, player = 'local' } = {}) {
  if (!store) throw new Error('experience editor needs a store');

  const guard = ({ kind, reason }) => {
    if (!PRIVATE_KINDS.has(String(kind ?? ''))) return { ok: false, reason: 'private-only' };
    const text = String(reason ?? '').trim();
    if (text.length < 4) return { ok: false, reason: 'reason-required' };
    return { ok: true, reason: text.slice(0, MAX_REASON) };
  };

  // 整份 md 覆盖：适合“把这一类经验整理一遍”。
  async function editFile({ kind, mdText, reason } = {}) {
    const checked = guard({ kind, reason });
    if (!checked.ok) return checked;
    if (!String(mdText ?? '').trim()) return { ok: false, reason: 'empty' };
    const result = await store.applyMdEdit({ kind, player, mdText: String(mdText), by: 'agent', reason: checked.reason });
    return { ok: true, ...result };
  }

  // 单行修订：只改一条经验时用它，避免整份覆盖误删别的条目。
  async function editLine({ kind, from, to, reason } = {}) {
    const checked = guard({ kind, reason });
    if (!checked.ok) return checked;
    const source = String(from ?? '').trim();
    const target = String(to ?? '').trim();
    if (!source || !target) return { ok: false, reason: 'empty' };
    const records = (await store.load()).filter((record) => record.kind === kind
      && (record.private ? record.player === player : false)
      && record.status !== 'retired');
    const match = records.find((record) => record.claim === source);
    if (!match) return { ok: false, reason: 'not-found' };
    // 退役旧条目 + 写入新条目：既保留历史，又不让新文本继承旧的验证次数。
    await store.correct(match.id, checked.reason);
    match.status = 'retired';
    const mdText = records.filter((record) => record.id !== match.id).map((record) => '- [0.5|1局|candidate] ' + record.claim).join(String.fromCharCode(10))
      + String.fromCharCode(10) + '- [0.5|1局|candidate] ' + target + String.fromCharCode(10);
    const result = await store.applyMdEdit({ kind, player, mdText, by: 'agent', reason: checked.reason });
    return { ok: true, retiredFrom: match.id, ...result };
  }

  const listPrivate = async () => (await store.load())
    .filter((record) => record.private && record.player === player && record.status !== 'retired')
    .map((record) => ({ id: record.id, kind: record.kind, claim: record.claim, evidence: record.evidence }));

  return { editFile, editLine, listPrivate, privateKinds: [...PRIVATE_KINDS] };
}
