import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runReplay } from '../replay.mjs';

test('phase-one structural replay labels mocks, verifies outcomes and never calls a real model', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/phase1.json', import.meta.url), 'utf8'));
  const report = await runReplay(fixture);
  assert.equal(report.cases, 19);
  assert.equal(report.failed, 0);
  assert.equal(report.mock_analysis_calls, 2);
  assert.equal(report.image_ocr_executed, false);
  assert.equal(report.cloud_model_called, false);
  assert.equal(report.mode, 'synthetic_structured_replay');
});

test('broken replay expectations fail visibly instead of passing a non-asserting demo', async () => {
  const report = await runReplay([{ at_ms: 10000, action: 'start', window_id: 'a', width: 1920,
    height: 1080, expected_status: 'completed' }]);
  assert.equal(report.failed, 1);
});

test('invalid replay time, input limit and actions are rejected', async () => {
  await assert.rejects(runReplay(null), /invalid_replay_records/);
  await assert.rejects(runReplay(Array(1001)), /invalid_replay_records/);
  await assert.rejects(runReplay([{ at_ms: 9999, action: 'stop' }]), /replay_time_not_monotonic/);
  await assert.rejects(runReplay([{ at_ms: 10000, action: 'shell' }]), /unknown_replay_action/);
});
