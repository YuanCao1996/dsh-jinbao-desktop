import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const exec = promisify(execFile);
const helper = fileURLToPath(new URL('../legacy-overlay.ps1', import.meta.url));

test('legacy overlay detection accepts only the actual old script in this Windows session', { skip: process.platform !== 'win32' }, async () => {
  const script = `
    $ErrorActionPreference='Stop'
    . '${helper.replaceAll("'", "''")}'
    $sid=(Get-Process -Id $PID).SessionId
    $rows=@(
      @{ProcessId=101;SessionId=$sid;Name='powershell.exe';CommandLine='powershell -File "D:/开发 目录/tools/lol-companion/overlay.ps1"'},
      @{ProcessId=102;SessionId=$sid;Name='powershell.exe';CommandLine='powershell -File D:/old/tools/lol-companion/overlay.ps1'},
      @{ProcessId=103;SessionId=$sid;Name='powershell.exe';CommandLine='powershell -File D:/old/tools/lol-companion/start-overlay.ps1'},
      @{ProcessId=104;SessionId=$sid;Name='powershell.exe';CommandLine='powershell -File D:/other/overlay.ps1'},
      @{ProcessId=105;SessionId=$sid;Name='powershell.exe';CommandLine='powershell -Command "echo D:/old/tools/lol-companion/overlay.ps1"'},
      @{ProcessId=106;SessionId=($sid+1);Name='powershell.exe';CommandLine='powershell -File D:/old/tools/lol-companion/overlay.ps1'},
      @{ProcessId=107;SessionId=$sid;Name='node.exe';CommandLine='node -File D:/old/tools/lol-companion/overlay.ps1'},
      @{ProcessId=$PID;SessionId=$sid;Name='powershell.exe';CommandLine='powershell -File D:/old/tools/lol-companion/overlay.ps1'}
    )
    ConvertTo-Json -InputObject @(Find-JinbaoLegacyOverlay -Processes $rows | ForEach-Object {$_.pid}) -Compress
  `;
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
  assert.deepEqual(JSON.parse(stdout), [101, 102]);
});

test('native entry yields to a legacy window and still starts normally when none exists', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinbao-entry-'));
  try {
    const launcher = join(root, 'tools/jinbao-launcher');
    const desktop = join(root, 'tools/desktop-release');
    await Promise.all([mkdir(launcher, { recursive: true }), mkdir(desktop, { recursive: true }), mkdir(join(root, 'runtime'))]);
    await copyFile(process.execPath, join(root, 'runtime/node.exe'));
    await copyFile(helper, join(launcher, 'legacy-overlay.ps1'));
    await writeFile(join(launcher, 'legacy-window.ps1'), "function Show-JinbaoLegacyOverlay { param($Legacy) [IO.File]::WriteAllText((Join-Path $StateDir 'legacy-show-called'),'yes'); return $true }");
    await copyFile(fileURLToPath(new URL('../start.ps1', import.meta.url)), join(launcher, 'start.ps1'));
    await writeFile(join(desktop, 'start-overlay.ps1'), "param($StateDir)\n[IO.File]::WriteAllText((Join-Path $StateDir 'overlay-called'),'yes')");
    await writeFile(join(launcher, 'main.mjs'), "import fs from 'node:fs';import path from 'node:path';fs.writeFileSync(path.join(process.argv[3],'manager-called'),'yes');");
    for (const legacy of [true, false]) {
      const state = join(root, legacy ? 'legacy' : 'fresh');
      const script = `
        $ErrorActionPreference='Stop'
        function Get-CimInstance {
          ${legacy ? "[pscustomobject]@{ProcessId=101;SessionId=(Get-Process -Id $PID).SessionId;Name='powershell.exe';CommandLine='powershell -File D:/old/tools/lol-companion/overlay.ps1'}" : '@()'}
        }
        & '${join(launcher, 'start.ps1').replaceAll("'", "''")}' -StateDir '${state.replaceAll("'", "''")}'
      `;
      await exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
      const status = JSON.parse(await readFile(join(state, 'launcher-state.json'), 'utf8'));
      assert.equal(status.phase, legacy ? 'legacy-active' : 'starting');
      if (legacy) await access(join(state, 'legacy-show-called'));
      else await assert.rejects(access(join(state, 'legacy-show-called')));
      for (const marker of ['overlay-called', 'manager-called']) {
        if (legacy) await assert.rejects(access(join(state, marker)));
        else await access(join(state, marker));
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
