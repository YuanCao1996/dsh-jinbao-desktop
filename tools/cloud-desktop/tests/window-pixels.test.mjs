import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('window-only capture renders an owned offscreen window and never reads the desktop',{skip:process.platform!=='win32'},()=>{
 const result=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('../../desktop-release/tests/window-pixels.test.ps1',import.meta.url))],{windowsHide:true,encoding:'utf8',timeout:20000}).trim());
 assert.equal(result.windowOnly,true);assert.equal(result.screenFallbackUsed,false);assert.equal(result.blackFrameRejected,true);
 assert.equal(result.screenFallbackBlackRejected,true);assert.equal(result.fallbackLeaseReleased,true);
});
