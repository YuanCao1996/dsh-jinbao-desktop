import { defineTool } from '@deepseek-ai/dsh-tools';

// 把“修订私有经验”暴露成教练可调用的工具。
//
// 只暴露私有类别，并且强制要求 reason：模型能改的是玩家自己的经验，改完必须能解释为什么。
export function registerExperienceTools(ctx, editor) {
  if (!ctx?.tools?.register || !editor) return;
  const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
  ctx.tools.register(defineTool({
    name: 'experience_list',
    description: '列出玩家自己的私有经验（偏好/纠正/战绩/踩坑/风格）。只读，不含社区共享经验。',
    parameters: {},
    output, timeoutMs: 8000, isConcurrencySafe: () => true,
    execute: async () => ({ lessons: await editor.listPrivate() }),
  }));
  ctx.tools.register(defineTool({
    name: 'experience_edit',
    description: '修订玩家自己的一条私有经验。当发现某条经验与当前版本/实际对局明显不符时使用：from 必须是现有结论原文，to 是修订后的结论，reason 说明依据（例如“14.21 已移除该机制”）。只能改私有经验，社区共享经验不在此列。',
    parameters: {
      kind: { type: 'string', required: true, description: 'preference/correction/stats/pitfall/style' },
      from: { type: 'string', required: true },
      to: { type: 'string', required: true },
      reason: { type: 'string', required: true },
    },
    output, timeoutMs: 8000, isConcurrencySafe: () => false,
    execute: (args) => editor.editLine(args),
  }));
}
