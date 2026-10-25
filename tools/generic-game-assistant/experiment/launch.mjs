import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { prepareExperiment } from './prepare.mjs';

const folder = await prepareExperiment();
const child = spawn(process.execPath, [join(folder, 'tools/generic-game-assistant/experiment/main.mjs')],
  { cwd: folder, windowsHide: true, stdio: 'inherit', env: { ...process.env,
    DSH_HOME: join(folder, 'state'), DSH_TELEMETRY_DISABLED: '1' } });
child.on('error', () => { console.error('experiment_start_failed'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
