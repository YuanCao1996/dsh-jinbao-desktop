import { defineTool, ToolRuntime } from '@deepseek-ai/dsh-tools';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import { GENERIC_SYSTEM_PROMPT } from './context.mjs';
import { assertSdkSingleton } from './sdk-check.mjs';

export const GENERIC_TOOL_NAMES = Object.freeze(['generic_read_state', 'generic_observe', 'generic_read_screen', 'generic_plan', 'generic_reply']);
function argumentsOnly(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !names.includes(key))) {
    throw new Error('tool_scope_override_denied');
  }
}
const roiSchema = { type: 'object', properties: {
  x: { type: 'number', required: true }, y: { type: 'number', required: true },
  width: { type: 'number', required: true }, height: { type: 'number', required: true },
}, additionalProperties: false };

export function registerGenericTools(agentCtx, { runtime, sessionId, request, progress = () => {} }) {
  const notify = event => { try { progress(event); } catch {} };
  if (scopeOf(agentCtx) === undefined) throw new Error('agent_scope_required');
  assertSdkSingleton();
  if (!(agentCtx.tools instanceof ToolRuntime) || !(agentCtx.systemPrompt instanceof SystemPrompt)) {
    throw new Error('dsh_sdk_service_mismatch');
  }
  if (!agentCtx.tools?.restrict || !agentCtx.tools?.guard || !agentCtx.tools?.presentAs) {
    throw new Error('restricted_tools_api_required');
  }
  const owned = [];
  owned.push(agentCtx.tools.presentAs('native'));
  owned.push(agentCtx.tools.restrict({ allow: [] }));
  owned.push(agentCtx.tools.guard(exec => {
    if (!GENERIC_TOOL_NAMES.includes(exec.name)) return 'generic_tool_denied';
    const active = request();
    if (!active || active.finished || active.signal.aborted) return 'generic_request_inactive';
    if (runtime.status().session_id !== sessionId) return 'generic_session_changed';
    if (++active.toolCalls > 8) return 'generic_tool_budget_exhausted';
  }));
  owned.push(agentCtx.systemPrompt.section({ name: 'generic-game:policy', order: 120, complete: true, text: GENERIC_SYSTEM_PROMPT
    + '\n只使用本会话工具。generic_observe仅截取本地画面；需要读懂画面且image_upload已授权时调用generic_read_screen，不确定字段保持未知。'
    + '\n每轮最多一次云端读图。工具因预算、冷却或输出不完整失败时不要重复调用；不能把失败说成已经看懂。'
    + '\n只通过generic_reply提交最终文字，最多256字；提交后停止本轮。' }));

  function tool(name, description, parameters, keys, run) {
    const definition = defineTool({ name, description, parameters,
      timeoutMs: 15000, isConcurrencySafe: () => false,
      output: { schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args, exec) {
        argumentsOnly(args, keys);
        const active = request();
        if (!active || active.finished || active.signal.aborted || exec?.signal?.aborted) throw new Error('generic_request_inactive');
        if (runtime.status().session_id !== sessionId) throw new Error('generic_session_changed');
        notify({ tool: name, phase: 'started' });
        const signal = exec?.signal ? AbortSignal.any([active.signal, exec.signal]) : active.signal;
        try {
          const value = await run(args, active, signal, exec);
          notify({ tool: name, phase: 'completed' });
          return value;
        } catch (error) {
          notify({ tool: name, phase: 'failed', reason: /^[a-z0-9_]+$/.test(error.message) ? error.message : 'tool_failed' });
          throw error;
        }
      },
    });
    owned.push(agentCtx.tools.register(definition));
    return definition;
  }
  const definitions = [
    tool('generic_read_state', '读取当前授权窗口的最新观察与游戏事实；unread只表示截到画面，不表示已理解。', {}, [], () => runtime.state()),
    tool('generic_read_screen', '按需读取已授权窗口；focus描述本次问题关心的可见信息，避免提取无关对象。每轮最多一次云端读图。',
      { focus: { type: 'string' } }, ['focus'], async (args, active, signal) => {
        active.visionCalls = (active.visionCalls ?? 0)+1;
        if (active.visionCalls > 1) throw new Error('turn_visual_budget_exhausted');
        return runtime.readScreen({ signal, focus: args.focus ?? '', admitObservation: () => {
          if (++active.observations > 2) throw new Error('turn_observation_budget_exhausted');
        } });
      }),
    tool('generic_observe', '只观察当前已授权窗口；模型不能选择别的窗口或输出路径。',
      { quality: { type: 'string', enum: ['overview', 'standard', 'detail'] }, roi: roiSchema }, ['quality', 'roi'],
      async (args, active, signal) => {
        if (++active.observations > 2) throw new Error('turn_observation_budget_exhausted');
        if (Object.keys(args).length) runtime.plan({ ...args, duration_ms: 5000 });
        return runtime.observe({ manual: true, signal });
      }),
    tool('generic_plan', '提出短期观察区域、清晰度和间隔，本地资源限制始终生效，最长30秒。',
      { quality: { type: 'string', enum: ['overview', 'standard', 'detail'] }, roi: roiSchema,
        task: { type: 'string', enum: ['general','layout','text'] },
        regions: { type: 'array', items: roiSchema },
        interval_ms: { type: 'integer' }, duration_ms: { type: 'integer' } },
      ['quality', 'roi', 'regions', 'task', 'interval_ms', 'duration_ms'], args => ({ status: 'accepted',
        automatic_observation: runtime.status().automatic === true, ...runtime.plan(args) })),
    tool('generic_reply', '提交最终回复并结束本轮；不显示思考过程，不超过256字。',
      { text: { type: 'string', required: true } }, ['text'], (args, active, _signal, exec) => {
        const text = args.text.trim();
        if (!text || [...text].length > 256) throw new Error('invalid_final_reply_length');
        if (typeof exec.concludeTurn !== 'function') throw new Error('turn_conclusion_api_required');
        // Commit a real DSH turn conclusion, not a pre-step rejection that leaves the next inbox stranded.
        exec.concludeTurn();
        active.finished = true;
        active.resolve(text);
        return { accepted: true };
      }),
  ];
  return { definitions, async dispose() {
    for (const stop of owned.reverse()) await stop?.();
  } };
}
