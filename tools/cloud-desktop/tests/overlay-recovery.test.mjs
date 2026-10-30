import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createOverlaySupervisor} from '../overlay-supervisor.mjs';
const execute=promisify(execFile),source=fileURLToPath(new URL('../../desktop-release/start-overlay.ps1',import.meta.url));
test('Windows launch captures errors, recovers a lost owned process, and preserves a user exit', {skip:process.platform!=='win32'},async()=>{
 const temp=await mkdtemp(join(tmpdir(),'jinbao-overlay-recovery-')),state=join(temp,'state'),scripts=join(temp,'tools','desktop-release'),pids=[];
 let clock=Date.now(),supervisor;
 const read=async name=>{try{return JSON.parse(await readFile(join(state,name),'utf8'));}catch{return null;}};
 const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
 const wait=async predicate=>{for(let i=0;i<100;i++){if(await predicate())return;await new Promise(r=>setTimeout(r,50));}throw Error('Owned fixture process did not reach the expected state');};
 try{
  await mkdir(scripts,{recursive:true});await mkdir(join(temp,'tools','jinbao-launcher'),{recursive:true});await mkdir(state);
  await copyFile(source,join(scripts,'start-overlay.ps1'));
  await writeFile(join(temp,'tools','jinbao-launcher','legacy-overlay.ps1'),'function Find-JinbaoLegacyOverlay { @() }');
  await writeFile(join(scripts,'strategy-overlay.ps1'),`param([string]$StateDir)
[Console]::Error.WriteLine('owned fixture diagnostic')
[IO.File]::WriteAllText((Join-Path $StateDir 'overlay-capture-host.json'),(@{pid=$PID;at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}|ConvertTo-Json -Compress))
Start-Sleep -Seconds 60
`);
  const launch=async recover=>{
   await execute('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(scripts,'start-overlay.ps1'),'-StateDir',state,...(recover?['-Recover']:[])],{windowsHide:true,timeout:15000});
   pids.push((await read('overlay-process.json')).pid);
  };
  supervisor=createOverlaySupervisor({stateDir:state,now:()=>clock,launch});await supervisor.start();
  await wait(async()=> (await read('overlay-capture-host.json'))?.pid===pids[0]);
  assert.equal(alive(pids[0]),true);process.kill(pids[0]);await wait(()=>!alive(pids[0]));
  clock+=16000;await supervisor.tick();assert.equal(pids.length,2);assert.notEqual(pids[0],pids[1]);
  await wait(async()=> (await read('overlay-capture-host.json'))?.pid===pids[1]);
  const logNames=await readdir(join(state,'overlay-diagnostics'));assert.equal(logNames.filter(n=>n.endsWith('.stderr.log')).length,2);
  assert.ok((await Promise.all(logNames.filter(n=>n.endsWith('.stderr.log')).map(n=>readFile(join(state,'overlay-diagnostics',n),'utf8')))).some(s=>s.includes('owned fixture diagnostic')));
  await writeFile(join(state,'overlay-stopped'),'user exit');process.kill(pids[1]);await wait(()=>!alive(pids[1]));clock+=16000;await supervisor.tick();assert.equal(pids.length,2);
  await execute('powershell.exe',['-NoProfile','-File',join(scripts,'start-overlay.ps1'),'-StateDir',state,'-Recover'],{windowsHide:true});
  assert.equal(await readFile(join(state,'overlay-stopped'),'utf8'),'user exit');
 }finally{
  await supervisor?.close();for(const pid of pids)if(alive(pid))process.kill(pid);
  assert.equal(dirname(resolve(temp)),resolve(tmpdir()));await rm(temp,{recursive:true,force:true,maxRetries:3,retryDelay:100});
 }
});
