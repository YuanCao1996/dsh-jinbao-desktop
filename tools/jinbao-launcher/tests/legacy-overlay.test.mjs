import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
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
