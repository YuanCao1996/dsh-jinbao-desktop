// Each source owns its DSH Agent and reply state. The bank bounds idle sessions
// without sharing message history between games or matches.
export function createMonitorBank(create, limit = 8) {
  const entries = new Map();
  let current = null;
  function get(game, source) {
    const key = game + ':' + source;
    let monitor = entries.get(key);
    if (!monitor) {
      if (entries.size >= limit) {
        const idle = [...entries].find(([, value]) => {
          const status = value.health(); return !status.running && status.queued === 0;
        });
        if (!idle) throw Error('Coach sessions are busy');
        idle[1].close(); entries.delete(idle[0]);
      }
      monitor = create(game, source); entries.set(key, monitor);
    }
    current = monitor;
    return monitor;
  }
  return {
    get,
    push(text, game, source) { get(game, source).push(text); },
    isReady() { return current?.isReady() ?? false; },
    health() { return { ...(current?.health() ?? { ready: false, queued: 0, running: false }), sessions: entries.size }; },
    clearQueue() { for (const monitor of entries.values()) monitor.clearQueue(); },
    finish(game, source) {
      const key = game + ':' + source, monitor = entries.get(key);
      if (!monitor) return;
      monitor.close(); entries.delete(key);
      if (current === monitor) current = entries.values().next().value ?? null;
    },
    close() { for (const monitor of entries.values()) monitor.close(); entries.clear(); current = null; },
  };
}
