import test from 'node:test';import assert from 'node:assert/strict';import{execFile}from'node:child_process';import{promisify}from'node:util';import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{fileURLToPath}from'node:url';
test('real registered Windows shortcuts reach the overlay and capture leases are acknowledged and released',{skip:process.platform!=='win32',timeout:20000},async()=>{
 const stateDir=await mkdtemp(join(tmpdir(),'jinbao-native-input-'));
 try{const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('../../desktop-release/tests/overlay-native-input.ps1',import.meta.url)),'-StateDir',stateDir],{windowsHide:true,timeout:18000});const result=JSON.parse(stdout.trim());for(const value of Object.values(result))assert.equal(value,true);}
 finally{await rm(stateDir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});
