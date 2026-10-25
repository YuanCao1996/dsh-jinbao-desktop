import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createWindowObserver } from '../windows.mjs';
import { recognizeGomokuPixels } from '../../generic-game-assistant/adapters/gomoku/pixels.mjs';

if (process.platform !== 'win32' || !process.argv.includes('--allow-test-window')) {
  throw new Error('Use --allow-test-window on Windows; this opens a fixture and captures only that fixture.');
}
const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const fixture = spawn(executable, ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File',
  fileURLToPath(new URL('./fixtures/board-fixture.ps1', import.meta.url))], { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
const folder = resolve('workspace/generic-game', `native-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const observer = createWindowObserver({ enabled: true });
const report = { mode: 'real_windows_fixture_capture', real_game_tested: false, cloud_model_called: false,
  overlay_occlusion_tested: true, captures: [] };
let timer;
try {
  await new Promise((resolveReady, reject) => {
    timer = setTimeout(() => reject(new Error('fixture_start_timeout')), 20000);
    let text = '';
    fixture.stdout.on('data', data => {
      text += data.toString('utf8');
      if (text.includes('fixture_ready')) { report.fixture_stdout = text; clearTimeout(timer); resolveReady(); }
    });
    fixture.once('error', reject);
    fixture.once('exit', code => reject(new Error(`fixture_exited_${code}`)));
    fixture.stderr.on('data', data => process.stderr.write(data));
  });
  let windows = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    windows = await observer.list();
    if (windows.some(value => value.pid === fixture.pid && value.title === 'Generic Board Fixture')) break;
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  report.window_inventory_count = windows.length;
  report.fixture_pid = fixture.pid;
  report.fixture_candidates = windows.filter(value => value.pid === fixture.pid || value.title === 'Generic Board Fixture');
  const window = windows.find(value => value.pid === fixture.pid && value.title === 'Generic Board Fixture');
  assert.ok(window, 'own fixture is visible in window inventory');
  assert.equal(windows.some(value => value.title === 'Jinbao fixture overlay'), false);
  await observer.select({ id: window.id, authorized: true });
  await mkdir(folder, { recursive: true });
  for (const [name, request] of [['full', { quality: 'standard' }],
    ['crop', { quality: 'standard', roi: { x: 0.03125, y: 0.03125, width: 0.9375, height: 0.9375 } }]]) {
    const start = performance.now();
    const captured = await observer.capture(request);
    const captureMs = performance.now() - start;
    const inferenceStart = performance.now();
    const recognition = recognizeGomokuPixels(captured.image);
    const recognizeMs = performance.now() - inferenceStart;
    assert.equal(recognition.status, 'observed');
    assert.equal(recognition.unknown_cells, 0);
    const expected = new Map([[0, 'black'], [112, 'black'], [113, 'white'], [224, 'white']]);
    for (let i = 0; i < 225; i++) assert.equal(recognition.state.cells[i], expected.get(i) ?? 'empty', `cell ${i}`);
    const path = join(folder, `${name}.png`);
    await writeFile(path, captured.png);
    report.captures.push({ name, path, frame: captured.frame, geometry: captured.geometry,
      capture_ms: Math.round(captureMs), recognize_ms: Math.round(recognizeMs), bytes: captured.png.length,
      exclusion_method: captured.exclusion_method, correct_cells: 225, total_cells: 225,
      recognition });
  }
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.message;
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  observer.clear();
  if (fixture.exitCode === null) {
    const exited = once(fixture, 'exit');
    fixture.kill();
    await exited;
  }
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ passed: report.passed, error: report.error, captures: report.captures.map(value => ({
    name: value.name, correct_cells: value.correct_cells, capture_ms: value.capture_ms,
    recognize_ms: value.recognize_ms, bytes: value.bytes })), report: join(folder, 'report.json'),
    cloud_model_called: false, real_game_tested: false }));
}
