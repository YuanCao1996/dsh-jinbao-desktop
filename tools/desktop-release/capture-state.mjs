import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createMatchTracker } from '../dsh-coach-server/lib/match-tracker.js';

export function createCaptureIdentity({ folder, serial, now = Date.now,
  newSource = () => 'wzry-' + randomUUID(), maxAgeMs = 30 * 60 * 1000 }) {
  const tracker = createMatchTracker();
  const filename = serial ? join(folder, '.capture-' + createHash('sha256').update(serial).digest('hex') + '.json') : null;
  let source = newSource(), lastSaved = 0;
  if (filename) try {
    const saved = JSON.parse(readFileSync(filename, 'utf8'));
    if (typeof saved.source === 'string' && /^wzry-[a-zA-Z0-9-]{1,80}$/.test(saved.source) &&
        Number.isFinite(saved.savedAt) && now() >= saved.savedAt && now() - saved.savedAt <= maxAgeMs &&
        tracker.restore('wzry', saved.source, saved.snapshot)) source = saved.source;
  } catch { /* Missing or invalid metadata starts an independent capture. */ }
  function save(force = false) {
    if (!filename || !force && now() - lastSaved < 1000) return;
    const snapshot = tracker.snapshot('wzry', source);
    if (!snapshot) return;
    try {
      writeFileSync(filename + '.tmp', JSON.stringify({ source, savedAt: now(), snapshot }), { mode: 0o600 });
      renameSync(filename + '.tmp', filename);
      lastSaved = now();
      return true;
    } catch { return false; } // Recovery metadata must not prevent the primary log write.
  }
  return {
    source,
    identify(observation) {
      const identity = tracker.identify('wzry', source, observation);
      save(identity.boundary || observation.ended);
      return identity;
    },
    save,
  };
}
