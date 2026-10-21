import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
test('native overlay preserves input/scroll/resize and supports readable messages, copy, latest jump and mode picker', {skip:process.platform!=='win32'},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'jinbao-ui-'));
 assert.equal(dirname(directory),resolve(tmpdir()));
 try{
  const script=fileURLToPath(new URL('../../desktop-release/strategy-overlay.ps1',import.meta.url));
  const output=execFileSync(join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',script,'-StateDir',directory,'-SelfTest'],{encoding:'utf8',windowsHide:true,timeout:30000});
  const result=JSON.parse(output.trim());
  for(const key of ['chatBubbles','fullChatMessage','messageCopyAvailable','richFontZoom','chatSendingFeedback','chatJumpVisible','chatJumpWorks','quickModePicker','quickModeSwitch'])assert.equal(result[key],true,key);
  for(const [name,value]of Object.entries(result))if(typeof value==='boolean')assert.equal(value,true,name);
 }finally{await rm(directory,{recursive:true,force:true});}
});
