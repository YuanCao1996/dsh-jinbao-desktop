import z from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createGenericRuntime } from './runtime.mjs';
import { createDshAnalyzer } from './dsh.mjs';

export const name = 'jinbao-generic-game';
export const inject = ['agentLoop', 'tools', 'systemPrompt'];
export const Config = z.object({ enabled: z.boolean().default(false),
  provider: z.string().default(''), model: z.string().default(''),
  sessionCwd: z.string().default(join(homedir(), '.dsh', 'jinbao', 'generic-game')) });

export function apply(ctx, cfg = {}) {
  if (cfg.enabled !== true) return;
  let runtime;
  const diagnostic = value => {
    try { ctx.emit('generic-game/diagnostic', value); } catch {}
  };
  const analyzer = createDshAnalyzer(ctx, { enabled: true, runtime: () => runtime,
    provider: cfg.provider, model: cfg.model, cwd: cfg.sessionCwd,
    progress: value => diagnostic({ event: 'tool_progress', ...value }) });
  runtime = createGenericRuntime({ enabled: true, analyze: value => analyzer.analyze(value), log: diagnostic,
    specializedActive: async () => {
      // The human-facing host must supply a trustworthy activity probe. Models cannot override it.
      const activity = ctx.get('genericGameActivity');
      if (typeof activity?.specializedActive !== 'function') throw new Error('specialized_activity_not_checked');
      return activity.specializedActive();
    } });
  ctx.provide('genericGame', { start: value => runtime.start(value), ask: value => runtime.ask(value),
    observe: value => runtime.observe(value), state: () => runtime.state(), status: () => runtime.status(),
    stop: async () => { runtime.stop(); await analyzer.close(); } });
  ctx.effect(() => async () => { runtime.stop(); await analyzer.close(); });
}
