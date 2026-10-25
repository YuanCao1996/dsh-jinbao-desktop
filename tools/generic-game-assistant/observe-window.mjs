import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createWindowObserver } from '../game-observation/windows.mjs';
import { recognizeGomokuPixels } from './adapters/gomoku/pixels.mjs';

async function main() {
  const args = process.argv.slice(2);
  const observer = createWindowObserver({ enabled: true });
  if (args.length === 1 && args[0] === '--list') {
    console.log(JSON.stringify({ windows: await observer.list(), captured: false }, null, 2));
    return;
  }
  if (args.length !== 3 || args[0] !== '--target' || args[2] !== '--authorize') {
    throw new Error('Usage: observe-window.mjs --list OR --target <exact-window-id> --authorize');
  }
  await observer.select({ id: args[1], authorized: true });
  const start = performance.now();
  const capture = await observer.capture({ quality: 'standard' });
  const captureMs = performance.now() - start;
  const inferenceStart = performance.now();
  const recognition = recognizeGomokuPixels(capture.image);
  const inferenceMs = performance.now() - inferenceStart;
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const folder = resolve(root, 'workspace/generic-game', `observation-${Date.now()}`);
  await mkdir(folder, { recursive: true });
  const screenshot = join(folder, 'frame.png');
  await writeFile(screenshot, capture.png);
  const record = { module: 'generic-game-assistant', source: 'real_windows_capture',
    time: new Date().toISOString(), frame: capture.frame, screenshot_path: screenshot,
    geometry: capture.geometry, exclusion_method: capture.exclusion_method, recognition,
    capture_ms: Math.round(captureMs), recognition_ms: Math.round(inferenceMs), image_bytes: capture.png.length,
    cloud_model_called: false, engine_connected: false };
  await writeFile(join(folder, 'observation.json'), JSON.stringify(record, null, 2), 'utf8');
  await writeFile(join(folder, 'events.jsonl'), JSON.stringify(record) + '\n', 'utf8');
  console.log(JSON.stringify({ status: recognition.status, unknown_cells: recognition.unknown_cells,
    screenshot, report: join(folder, 'observation.json'), capture_ms: record.capture_ms,
    recognition_ms: record.recognition_ms, cloud_model_called: false }));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
