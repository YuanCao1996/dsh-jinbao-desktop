import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTeamBridge } from '../bridge.mjs';
import { createMobileTeamSession } from '../mobile-session.mjs';

test('desktop and mobile refresh an older cached answer with no new chat or model request', async t => {
  for (const platform of ['desktop', 'mobile']) {
    const room = { id: 'room', name: 'test', selfMemberId: 'me', ownerMemberId: 'me', members: [],
      messageCount: 60, currentMatch: { id: 'match' } };
    const rows = Array.from({ length: 60 }, (_, i) => ({ seq: i + 1, role: 'assistant', text: 'original-' + i,
      roomMatchId: 'match', adviceStatus: 'current' }));
    const scans = [], requests = [];
    const fetchImpl = async url => {
      const parsed = new URL(url), path = parsed.pathname; requests.push(path);
      const after = Number(parsed.searchParams.get('after') ?? 0);
      const messages = { items: rows.filter(row => row.seq > after).slice(0, 30), cursor: Math.min(after + 30, 60), hasMore: after + 30 < 60 };
      if (path.endsWith('/dashboard')) {
        const scan = parsed.searchParams.get('adviceAfter'); scans.push(scan);
        return Response.json({ room, messages, tasks: { items: [] }, budget: {}, memories: { items: [] },
          connections: { items: [] }, confirmations: { items: [] }, adviceCursor: 60, adviceHasMore: false,
          adviceUpdates: scan === null ? [] : [{ seq: 1, adviceStatus: 'context_changed' }] });
      }
      if (path.endsWith('/messages')) return Response.json(messages);
      return Response.json(room);
    };
    let controller;
    if (platform === 'desktop') {
      const stateDir = await mkdtemp(join(tmpdir(), 'team-advice-refresh-'));
      t.after(() => rm(stateDir, { recursive: true, force: true }));
      controller = await createTeamBridge({ stateDir, serviceBaseUrl: 'https://example.test', getToken: () => 'fixture', fetchImpl, pollMs: 60000 });
      t.after(() => controller.close());
      await controller.command('create', { name: 'test', displayName: 'me' });
      await controller.tick();
    } else {
      const saved = new Map();
      controller = createMobileTeamSession({ fetchImpl, accountKey: 'fixture', storage: {
        getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value),
      } });
      await controller.api('open', { roomId: 'room' });
      await controller.api();
    }
    const messages = controller.view().messages;
    assert.equal(messages.length, 60); assert.equal(messages[0].text, 'original-0');
    assert.equal(messages[0].adviceStatus, 'context_changed');
    assert.deepEqual(scans, [null, '0']);
    assert.ok(requests.every(path => !/tasks|observations|host-|model/.test(path)));
    if (platform === 'desktop') await controller.close();
  }
});
