import { join } from 'node:path';
import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createSdkHost } from './sdk-host.mjs';
import { createExperimentServer } from './server.mjs';
import { loadSharedModel } from './shared-model.mjs';

const stateDir = fileURLToPath(new URL('../../../state/', import.meta.url));
let server, closed = false;
const log = event => {
  void appendFile(join(stateDir, 'events.jsonl'), JSON.stringify(event) + '\n').catch(() => {});
};
const explicitModel = !!(process.env.GENERIC_MODEL_BASE_URL || process.env.GENERIC_MODEL_NAME || process.env.GENERIC_MODEL_API_KEY);
let sharedModel;
if (!explicitModel && process.env.GENERIC_MODEL_MODE !== 'off') {
  try { sharedModel = await loadSharedModel(); }
  catch (error) { console.error(JSON.stringify({ event: 'shared_model_unavailable', reason: error.message })); }
}
const host = await createSdkHost({ stateDir,
  sharedModel,
  modelConfig: { baseURL: process.env.GENERIC_MODEL_BASE_URL, model: process.env.GENERIC_MODEL_NAME,
    apiKey: process.env.GENERIC_MODEL_API_KEY },
  log, progress: event => server?.publish({ event: 'tool_progress', ...event }) });
server = await createExperimentServer({ host, port: Number(process.env.GENERIC_GAME_PORT ?? 3094), log });
console.log(JSON.stringify({ event: 'experiment_ready', url: server.url, model_ready: host.modelReady,
  model: host.modelSummary, stateDir }));
async function stop() {
  if (closed) return; closed = true;
  await server.close();
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
