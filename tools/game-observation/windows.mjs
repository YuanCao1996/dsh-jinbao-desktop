import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { planObservation, validateFrame } from './contracts.mjs';

export function callWindowsWorker(request, { signal, timeoutMs = 10000 } = {}) {
  if (process.platform !== 'win32') return Promise.reject(new Error('windows_only'));
  if (signal?.aborted) return Promise.reject(new Error('capture_cancelled'));
  return new Promise((resolve, reject) => {
    const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      fileURLToPath(new URL('./windows/worker.ps1', import.meta.url))], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let bytes = 0;
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) { child.kill(); reject(error); } else resolve(value);
    };
    const abort = () => finish(new Error('capture_cancelled'));
    const timer = setTimeout(() => finish(new Error('capture_timeout')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) return finish(new Error('capture_response_too_large'));
      chunks.push(chunk);
    });
    child.stderr.on('data', () => {});
    child.on('error', () => finish(new Error('capture_worker_unavailable')));
    child.stdin.on('error', () => finish(new Error('capture_worker_unavailable')));
    child.on('close', code => {
      if (done) return;
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
        if (!result.ok || code !== 0) throw new Error(result.reason ?? 'capture_worker_failed');
        finish(null, result);
      } catch (error) { finish(error); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export function decodeCapturedFrame(result, target, plan, nowMs = Date.now()) {
  const raw = result?.frame;
  if (!raw || raw.source !== 'windows_printwindow' || raw.exclusion_method !== 'target_client_render_only'
      || raw.width !== plan.output_size.width || raw.height !== plan.output_size.height
      || typeof raw.png_base64 !== 'string' || typeof raw.rgb_base64 !== 'string') throw new Error('invalid_capture_payload');
  const png = Buffer.from(raw.png_base64, 'base64');
  const rgb = Buffer.from(raw.rgb_base64, 'base64');
  if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || png.readUInt32BE(16) !== raw.width || png.readUInt32BE(20) !== raw.height
      || rgb.length !== raw.width * raw.height * 3) throw new Error('invalid_capture_image');
  const metadata = { ...raw, sha256: createHash('sha256').update(png).digest('hex') };
  const frame = validateFrame(metadata, target, nowMs);
  let low = 255, high = 0;
  let sentinel = 0, samples = 0;
  for (let i = 0; i < rgb.length; i += Math.max(3, Math.floor(rgb.length / 30000 / 3) * 3)) {
    low = Math.min(low, rgb[i], rgb[i + 1], rgb[i + 2]);
    high = Math.max(high, rgb[i], rgb[i + 1], rgb[i + 2]);
    if (rgb[i] > 240 && rgb[i + 1] < 15 && rgb[i + 2] > 240) sentinel += 1;
    samples += 1;
  }
  if (high - low < 8 || sentinel / samples > 0.1) throw new Error('window_render_empty');
  return { frame, png, image: { width: raw.width, height: raw.height, rgb },
    geometry: { pixel_roi: plan.pixel_roi, source_size: { width: target.width, height: target.height },
      output_size: plan.output_size }, source: raw.source, exclusion_method: raw.exclusion_method };
}

export function createWindowObserver({ enabled = false, worker = callWindowsWorker } = {}) {
  let selected = null;
  let busy = false;
  let generation = 0;
  return {
    async list({ signal } = {}) {
      if (!enabled) return [];
      const result = await worker({ action: 'list' }, { signal });
      return result.windows;
    },
    async select({ id, authorized, signal }) {
      if (!enabled) throw new Error('observation_disabled');
      if (authorized !== true) throw new Error('authorized_window_required');
      generation += 1;
      const expected = generation;
      selected = null;
      const windows = await this.list({ signal });
      if (expected !== generation) throw new Error('target_changed');
      const target = windows.find(value => value.id === id);
      if (!target) throw new Error('target_not_available');
      const plan = planObservation({ ...target, kind: 'window', authorized: true });
      selected = { ...target, kind: 'window', authorized: true };
      return { ...selected, initial_plan: plan };
    },
    clear() { generation += 1; selected = null; },
    async capture(request = {}, { signal } = {}) {
      if (!enabled) throw new Error('observation_disabled');
      if (!selected) throw new Error('no_authorized_window');
      if (busy) throw new Error('capture_busy');
      const target = selected;
      const expected = generation;
      const plan = planObservation(target, request);
      busy = true;
      try {
        const result = await worker({ action: 'capture', target_id: target.id, authorized: true,
          width: target.width, height: target.height, plan }, { signal });
        if (expected !== generation || selected !== target) throw new Error('target_changed');
        return decodeCapturedFrame(result, target, plan);
      } catch(error) {
        if(error.message==='target_geometry_changed' && expected===generation && selected===target){
          const result=await worker({action:'list'},{signal});
          if(expected!==generation || selected!==target)throw new Error('target_changed');
          const refreshed=result.windows.find(item=>item.id===target.id);
          if(!refreshed)throw new Error('target_not_available');
          selected={...refreshed,kind:'window',authorized:true};
        }
        throw error;
      } finally { busy = false; }
    },
  };
}
