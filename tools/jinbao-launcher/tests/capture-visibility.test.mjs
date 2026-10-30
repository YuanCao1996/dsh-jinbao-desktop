import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
for(const [name,preferences,expected] of [['fresh',null,0],['legacy-default',{showInCapture:false},0],['explicit-hidden',{showInCapture:false,capturePreferenceVersion:2},17]]){
 test('capture visibility '+name,{skip:process.platform!=='win32'},async()=>{
  const state=await mkdtemp(join(tmpdir(),'jinbao-capture-'));
  try{
   if(preferences)await writeFile(join(state,'strategy-overlay-preferences.json'),JSON.stringify(preferences));
   const result=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('../../desktop-release/strategy-overlay.ps1',import.meta.url)),'-StateDir',state,'-SelfTest'],{encoding:'utf8',windowsHide:true,timeout:30000}).trim());
   assert.equal(result.initialCaptureAffinity,expected);assert.equal(result.captureVisible,true);assert.equal(result.captureHidden,true);assert.equal(result.captureVisibilitySaved,true);
   assert.equal(result.captureLeaseNoFlicker,true);assert.equal(result.captureLeaseRestoresPreference,true);
   assert.equal(result.captureLeasePartialFailureRecovers,true);
   assert.equal(result.captureHeartbeatLockSurvived,true);assert.equal(result.captureHeartbeatRecovers,true);
   assert.equal(result.captureReadyLockSurvived,true);assert.equal(result.captureReadyRecovers,true);
   assert.equal(result.captureIoFaultsRecorded,true);
  }finally{await rm(state,{recursive:true,force:true});}
 });
}
