import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { LlmRuntime } from '@deepseek-ai/dsh-llm';
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import * as pi from '@deepseek-ai/dsh-llm-pi-ai';
import { join, isAbsolute } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createDshAnalyzer } from '../dsh.mjs';
import { createGenericRuntime } from '../runtime.mjs';
import { createWindowObserver, callWindowsWorker } from '../../game-observation/windows.mjs';
import { assertSdkSingleton } from '../sdk-check.mjs';
import { createScreenReader } from '../vision-client.mjs';

export function validateModelConfig({ baseURL, model, apiKey } = {}) {
  if (!baseURL && !model && !apiKey) return null;
  const url = new URL(baseURL);
  if (url.username || url.password || url.search || url.hash
      || !(url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1')))
    throw new Error('invalid_model_endpoint');
  if (typeof model !== 'string' || !/^[a-zA-Z0-9_.:/-]{1,100}$/.test(model)
      || typeof apiKey !== 'string' || !apiKey.trim() || /[^\x21-\x7e]/.test(apiKey))
    throw new Error('invalid_model_config');
  return { baseURL: url.href.replace(/\/$/, ''), model, apiKey };
}

export async function createSdkHost({ stateDir, modelConfig, sharedModel, observer, specializedActive, log = () => {},
  progress = () => {}, adapter, timeoutMs = 55000 } = {}) {
  assertSdkSingleton();
  if (!stateDir || !isAbsolute(stateDir)) throw new Error('absolute_experiment_state_required');
  const config = validateModelConfig(modelConfig);
  if (sharedModel && (config || adapter)) throw new Error('model_source_conflict');
  if (sharedModel && (sharedModel.provider !== 'jinbao-server' || typeof sharedModel.resolveCredential !== 'function'
      || sharedModel.model !== 'game-fast' || sharedModel.baseURL !== 'https://api.jinbaoai.top/v1'))
    throw new Error('invalid_shared_model');
  const provider = sharedModel?.provider ?? 'generic-model';
  const model = sharedModel?.model ?? config?.model ?? (adapter ? 'fixture-model' : 'unconfigured');
  await mkdir(stateDir, { recursive: true });
  const ctx = new Context();
  let runtime, analyzer;
  try {
    new SessionStore(ctx);
    new SessionProjectionRegistry(ctx);
    new AgentRegistry(ctx);
    new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false });
    new ToolRuntime(ctx, { mode: 'native' });
    new LlmRuntime(ctx);
    new JsonlPersistence(ctx, { root: join(stateDir, 'sessions') });
    if (adapter) ctx.llm.registerAdapter(['generic-model'], adapter);
    else if (sharedModel) {
      // Only the selected reference can be resolved; the full production credential service is never mounted.
      ctx.provide('credentials', { resolve: async ref => ref === sharedModel.credentialRef
        ? sharedModel.resolveCredential() : undefined });
      pi.apply(ctx, { providers: { 'jinbao-server': { api: 'openai-completions', baseURL: sharedModel.baseURL,
        apiKeyEnv: sharedModel.credentialRef, defaultInput: ['text'],
        timeoutMs: 45000, streamIdleTimeoutMs: 45000, retryPolicy: { mode: 'normal', maxRetries: 0 },
        headers: { 'X-Jinbao-Operation': 'generic_game_development', 'User-Agent': 'jinbao-generic-experiment/0.1' },
        compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false,
          supportsUsageInStreaming: true, maxTokensField: 'max_tokens',
          requiresReasoningContentOnAssistantMessages: true },
        // The server enables reasoning; its strict schema must not receive provider-specific thinking fields.
        models: [{ id: sharedModel.model, name: 'DeepSeek V4.1 Flash via Jinbao',
          reasoningEfforts: { low: 'low' }, contextWindow: 32768, maxTokens: 2048 }] } } });
      const metadata = await ctx.llm.resolveModelInfo(provider, model);
      if (!metadata || metadata.provider !== provider || metadata.id !== model) throw new Error('shared_model_not_supported');
    } else if (config) {
      // No credential file, ambient .env loader, settings watcher or production profile is mounted.
      ctx.provide('credentials', { resolve: async ref => ref === 'GENERIC_MODEL_API_KEY' ? { value: config.apiKey } : undefined });
      pi.apply(ctx, { providers: { 'generic-model': { api: 'openai-completions',
        baseURL: config.baseURL, apiKeyEnv: 'GENERIC_MODEL_API_KEY', defaultInput: ['text'],
        timeoutMs: 45000, streamIdleTimeoutMs: 45000, retryPolicy: { mode: 'normal', maxRetries: 0 },
        compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false,
          supportsUsageInStreaming: true, maxTokensField: 'max_tokens' },
        models: [{ id: config.model, name: config.model, contextWindow: 32768, maxTokens: 2048 }] } } });
    }
    new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 1 });
    await ctx.fiber.await();
    const windows = observer ?? createWindowObserver({ enabled: true });
    const activity = specializedActive ?? (async () => {
      const result = await callWindowsWorker({ action: 'specialized_activity' });
      if (typeof result.active !== 'boolean') throw new Error('specialized_activity_not_checked');
      return result.active;
    });
    analyzer = createDshAnalyzer(ctx, { enabled: true, runtime: () => runtime, provider,
      model, cwd: stateDir, timeoutMs, progress });
    runtime = createGenericRuntime({ enabled: true, observer: windows, specializedActive: activity, log,
      readImage: sharedModel ? createScreenReader({ sharedModel, log }) : undefined,
      analyze: value => {
        if (!config && !adapter && !sharedModel) throw new Error('model_not_configured');
        return analyzer.analyze(value);
      } });
    return { ctx, runtime, windows, modelReady: !!config || !!adapter || !!sharedModel,
      modelSummary: sharedModel?.summary ?? { mode: config ? 'independent' : adapter ? 'fixture' : 'off', provider, model },
      async stop() { runtime.stop(); await analyzer.close(); },
      async close() { runtime.stop(); await analyzer.close(); await ctx.fiber.dispose(); } };
  } catch (error) {
    await analyzer?.close();
    await ctx.fiber.dispose();
    throw error;
  }
}
