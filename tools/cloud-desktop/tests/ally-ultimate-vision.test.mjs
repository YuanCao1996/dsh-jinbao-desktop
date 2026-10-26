import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

test('production native ally HUD vision identifies synthetic portraits and markers at multiple scales',{skip:process.platform!=='win32',timeout:20000},async()=>{
 const script=fileURLToPath(new URL('../../desktop-release/tests/ally-ultimate-vision.ps1',import.meta.url));
 const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,timeout:18000});
 const result=JSON.parse(stdout.trim());for(const value of Object.values(result))assert.equal(value,true);
});
