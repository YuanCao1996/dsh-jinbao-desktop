import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('screen capture never bypasses a live overlay when heartbeat is corrupt or stale',{skip:process.platform!=='win32'},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jinbao-capture-lease-'));
 try{
  const value=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-File',fileURLToPath(new URL('../../desktop-release/tests/capture-coordination.test.ps1',import.meta.url)),'-StateDir',dir],{windowsHide:true,encoding:'utf8',timeout:15000}).trim());
  for(const key of ['corruptHeartbeatBlocked','staleActiveBlocked','stalePidIgnored','leaseReleased'])assert.equal(value[key],true);
 }finally{assert.equal(dirname(resolve(dir)),resolve(tmpdir()));await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});
