import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createGenericController } from './controller.mjs';

// Synthetic structural replay. This does not run screenshot OCR or a cloud model.
export async function runReplay(records) {
  if (!Array.isArray(records) || records.length > 1000) throw new Error('invalid_replay_records');
  let clock = 10000;
  let session;
  let target;
  let modelCalls = 0;
  const events = [];
  const controller = createGenericController({ enabled: true,
    wallNow: () => clock, now: () => clock, log: event => events.push(event),
    analyze: async () => { modelCalls += 1; return '已读取当前观察；尚未接入棋力引擎，不判断最佳落子。'; } });
  const results = [];
  for (const record of records) {
    if (!record || !Number.isSafeInteger(record.at_ms) || record.at_ms < clock) {
      throw new Error('replay_time_not_monotonic');
    }
    clock = record.at_ms;
    let result;
    if (record.action === 'start') {
      target = { kind: 'window', id: record.window_id, authorized: true,
        width: record.width, height: record.height };
      result = controller.start({ game: 'gomoku', target });
      session = result.session_id;
    } else if (record.action === 'observe') {
      const state = { board_size: 15, cells: Array(225).fill('empty'),
        turn: record.turn ?? 'black', player_color: 'black', rules: record.rules ?? 'freestyle' };
      for (const cell of record.cells ?? []) {
        if (!Number.isInteger(cell.index) || cell.index < 0 || cell.index >= state.cells.length) {
          throw new Error('invalid_replay_cell');
        }
        state.cells[cell.index] = cell.value;
      }
      result = controller.ingest({ session_id: session, state,
        frame: { target_id: target?.id, width: target?.width, height: target?.height,
          captured_at_ms: clock, assistant_excluded: record.assistant_excluded ?? true,
          // Not an image hash: reproducible identifier for synthetic fixture facts only.
          sha256: createHash('sha256').update(JSON.stringify(record)).digest('hex') } });
    } else if (record.action === 'question') {
      result = await controller.explain(record.text);
    } else if (record.action === 'stop') {
      controller.stop();
      result = { status: 'stopped' };
    } else {
      throw new Error('unknown_replay_action');
    }
    const passed = result.status === record.expected_status
      && (record.expected_reason === undefined || result.reason === record.expected_reason);
    results.push({ at_ms: clock, action: record.action, expected_status: record.expected_status,
      expected_reason: record.expected_reason, actual: result, passed });
  }
  return { mode: 'synthetic_structured_replay', image_ocr_executed: false, cloud_model_called: false,
    mock_analysis_calls: modelCalls, cases: results.length, passed: results.filter(r => r.passed).length,
    failed: results.filter(r => !r.passed).length, results, events };
}

async function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: node replay.mjs <scenario.json> <report.json>');
  const records = JSON.parse((await readFile(resolve(input), 'utf8')).replace(/^\uFEFF/, ''));
  const report = await runReplay(records);
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(resolve(output), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ mode: report.mode, cases: report.cases,
    passed: report.passed, failed: report.failed, mock_analysis_calls: report.mock_analysis_calls,
    image_ocr_executed: false, cloud_model_called: false, report: resolve(output) }));
  if (report.failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
