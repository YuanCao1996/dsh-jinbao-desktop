import test from 'node:test';
import assert from 'node:assert/strict';
import { unchangedSentDraft } from '../client.mjs';
test('a late send acknowledgement clears only the original unmodified draft and room', () => {
  const sent = { revision: 1, roomId: 'one', text: '第一句话', ask: true, replyTo: 3 };
  assert.equal(unchangedSentDraft(sent, { ...sent }), true);
  for (const change of [{ revision: 2 }, { roomId: 'two' }, { text: '下一句话' }, { ask: false }, { replyTo: 4 }]) {
    assert.equal(unchangedSentDraft(sent, { ...sent, ...change }), false);
  }
  assert.equal(unchangedSentDraft(sent, { ...sent, revision: 3 }), false, 'editing and reverting text is still a new draft');
});
