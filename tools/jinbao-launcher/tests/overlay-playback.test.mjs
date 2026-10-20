import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

test('native overlay playback preserves messages and aligns subtitle/scroll behavior', { skip: process.platform !== 'win32' }, () => {
  const harness = fileURLToPath(new URL('../../desktop-release/tests/overlay-playback.test.ps1', import.meta.url));
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const output = execFileSync(powershell, ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', harness], {
    encoding: 'utf8', timeout: 30_000, windowsHide: true,
  });
  const results = JSON.parse(output.trim());
  assert.ok(Object.keys(results).length >= 17);
  for (const [name, passed] of Object.entries(results)) assert.equal(passed, true, name);
});
