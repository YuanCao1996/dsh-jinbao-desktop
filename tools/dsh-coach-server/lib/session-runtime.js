// Use DSH's durable-session API. A stable id alone does not turn createAgent into resume.
export async function openCoachSession(ctx, { sessionId, meta, ...options }) {
  const persistence = ctx.get('sessionPersistence');
  const stored = persistence?.stat ? await persistence.stat(sessionId, { signal: options.signal }) : undefined;
  if (stored) return ctx.agentLoop.resume(ctx, { ...options, resumeSessionId: sessionId });
  return ctx.agentLoop.createAgent(ctx, { ...options, sessionId, meta });
}
