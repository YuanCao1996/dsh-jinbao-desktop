// Match clocks may fluctuate briefly. Require two advancing low-clock observations
// before treating a large rollback as a new match in a long-lived source file.
export function createMatchTracker(limit = 64) {
  const sources = new Map();
  return {
    identify(game, file, { seconds, at = 0, started = false, ended = false, match } = {}) {
      const key = game + ':' + file;
      let source = sources.get(key);
      if (!source) {
        source = { sequence: 1, clock: null, candidate: null, candidateAt: 0, at: 0, ended: false, started:false };
        if (sources.size >= limit) sources.delete(sources.keys().next().value);
        sources.set(key, source);
      }
      if (typeof match === 'string' && match.length <= 300) return { match, pending: false };
      if (at < source.at) return { match: file + '#' + source.sequence, pending: true };
      let boundary = false, pending = false;
      // Loading metadata may arrive after the first live state in an existing
      // recording. Its first start marker belongs to that same match. Duplicate
      // metadata before the first positive clock is not another match; a start
      // after live play or GameEnd is a genuine new boundary.
      if (started && source.at > 0 && (source.ended||(source.started&&source.clock!==null&&source.clock>0))) { source.sequence++; source.clock = null; source.candidate = null; source.ended = false; boundary = true; }
      if(started)source.started=true;
      if (Number.isFinite(seconds) && seconds >= 0) {
        if (source.clock !== null && source.clock - seconds >= 120) {
          if (source.candidate !== null && at > source.candidateAt && seconds > source.candidate && seconds - source.candidate <= 60) {
            source.sequence++; source.clock = seconds; source.candidate = null; source.ended = false; source.started=false; boundary = true;
          } else { source.candidate = seconds; source.candidateAt = at; pending = true; }
        } else { source.clock = Math.max(source.clock ?? 0, seconds); source.candidate = null; }
      }
      source.at = Math.max(source.at, at);
      if (ended) source.ended = true;
      return { match: file + '#' + source.sequence, boundary, pending, ended: source.ended };
    },
    snapshot(game, file) {
      const value = sources.get(game + ':' + file);
      return value ? { ...value } : null;
    },
    restore(game, file, value) {
      const clock = field => field === null || Number.isFinite(field) && field >= 0 && field <= 21600;
      if (!value || !Number.isInteger(value.sequence) || value.sequence < 1 || value.sequence > 1000000 ||
          !clock(value.clock) || !clock(value.candidate) || !Number.isFinite(value.at) || value.at < 0 ||
          !Number.isFinite(value.candidateAt) || value.candidateAt < 0 || typeof value.ended !== 'boolean'||(value.started!==undefined&&typeof value.started!=='boolean')) return false;
      sources.set(game + ':' + file, { sequence: value.sequence, clock: value.clock, candidate: value.candidate,
        candidateAt: value.candidateAt, at: value.at, ended: value.ended,started:value.started===true });
      return true;
    },
    clear() { sources.clear(); },
  };
}
