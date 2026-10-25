import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,access} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {buildPreview} from '../build-preview.mjs';

test('portable cloud artifact starts with its own runtime and no node_modules or ADB',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const root=fileURLToPath(new URL('../../../',import.meta.url));
 // Keep executable fixtures inside the workspace's permitted execution tree.
 const temp=await mkdtemp(join(root,'.cloud-package-'));
 const out=join(temp,'package'),state=join(temp,'state');let child;
 try{
  const report=await buildPreview({root,out});
  assert.equal(report.externalPackages,0);
  await assert.rejects(access(join(out,'node_modules')));
  await assert.rejects(access(join(out,'runtime/platform-tools/adb.exe')));
  await assert.rejects(access(join(out,'tools/dsh-onboarding/plugin.mjs')));
  const vbs=await readFile(join(out,'start-preview.vbs'),'utf8');
  assert.match(vbs,/--collect --coach/);assert.ok(!vbs.includes('dsh-launcher'));
  child=spawn(join(out,'runtime/node.exe'),[join(out,'tools/cloud-desktop/entry.mjs'),'--headless','--collect','--state',state],{windowsHide:true,stdio:['ignore','pipe','pipe'],cwd:temp});
  let output='',errors='';child.stderr.on('data',b=>errors+=b);
  await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('Packaged startup timed out: '+errors)),15000);
   child.stdout.on('data',b=>{output+=b;if(output.includes('"standalone":true')){clearTimeout(timer);resolve();}});
   child.once('exit',code=>{clearTimeout(timer);reject(Error('Packaged startup exited '+code+': '+errors));});
  });
  // Wait until the packaged supervisor actually starts its collector subprocess.
  await new Promise(resolve=>setTimeout(resolve,3500));
  const url=new URL((await readFile(join(state,'settings-link.txt'),'utf8')).trim());
  const response=await fetch(url.origin+'/api/status',{headers:{'X-Jinbao-Setup':url.hash.slice(1)}});
  const status=await response.json();assert.equal(status.agentRuntime,'standalone');
  assert.equal(status.version,report.version+' (独立预览)');assert.match(status.releaseNotes,/本局日志/);
  assert.equal(status.mode,'cloud');assert.equal(child.exitCode,null);
  const exited=once(child,'exit');await writeFile(join(state,'overlay-stopped'),'test');await exited;
  assert.equal(child.exitCode,0);
 }finally{
  if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}
  await rm(temp,{recursive:true,force:true,maxRetries:3,retryDelay:100});
 }
});
