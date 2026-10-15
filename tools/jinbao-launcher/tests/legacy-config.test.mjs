import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from 'yaml';
import { disableLegacyPlugin } from '../../desktop-release/legacy-config.mjs';

test('release migration disables legacy startup and adapter writer while preserving configuration', () => {
  const original = [{ id: 'jinbao-probe', disabled: false, config: { port: 3098, toolsDir: 'D:/custom', autoStart: true } },
    { id: 'renamed-probe', name: 'dsh-plugin-jinbao-probe', config: { label: 'keep' } },
    { id: 'other', disabled: false, config: { autoStart: true } }];
  const doc = parseDocument(JSON.stringify(original));
  disableLegacyPlugin(doc, doc.contents.items);
  const rows = doc.toJS();
  assert.deepEqual(rows[0], { ...original[0], disabled: true, config: { ...original[0].config, autoStart: false } });
  assert.equal(rows[1].disabled, true);
  assert.equal(rows[1].config.label, 'keep');
  assert.deepEqual(rows[2], original[2]);
  disableLegacyPlugin(doc, doc.contents.items);
  assert.deepEqual(doc.toJS(), rows);
});
