import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as sleep} from 'node:timers/promises';
import {createUpdater} from './update.mjs';

export async function waitAndApply({prepared,inspect,parentRunning,launch,publish,cancelled,wait=sleep,now=Date.now,timeout=30*60*1000}){
 const first=await prepared();if(!first)throw Error('No verified update');
 const started=now();
 await publish({state:'waiting-host',version:first.release.version,message:'更新已安排，请保存工作并正常退出 DSH。金宝随后会自动重新启动。'});
 while(now()-started<timeout){
  if(await cancelled()){await publish({state:'cancelled',message:'已取消自动安装。金宝已退出，可从原入口重新打开。'});return 'cancelled';}
  if(!await parentRunning()&&!await inspect()){
   // Revalidate signed receipts and every file after waiting; never execute a stale path.
   const final=await prepared();if(!final||final.release.sha256!==first.release.sha256||final.root!==first.root)throw Error('Prepared update changed');
   if(await cancelled()){await publish({state:'cancelled',message:'已取消自动安装，可从原入口重新打开金宝。'});return 'cancelled';}
   await publish({state:'applying',version:final.release.version,message:'正在安装并启动新版金宝…'});
   await launch(final.root);return 'launched';
  }
  await wait(2000);
 }
 await publish({state:'failed',message:'等待 DSH 退出已超时，自动安装已取消。下次从原入口启动仍可更新。'});return 'timeout';
}

if(resolve(process.argv[1]??'')===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),value=n=>args[args.indexOf(n)+1];
 const stateDir=resolve(value('--state')),parent=Number(value('--parent')),id=value('--request');
 if(!/^[a-f0-9-]{36}$/.test(id??'')||!Number.isSafeInteger(parent)||parent<1)throw Error('Invalid apply request');
 const root=fileURLToPath(new URL('../../',import.meta.url)),dir=join(stateDir,'updates'),updater=createUpdater({root,stateDir});
 const publish=async data=>{await mkdir(dir,{recursive:true});const path=join(dir,'apply-status.json'),tmp=path+'.'+id+'.tmp';await writeFile(tmp,JSON.stringify({...data,id,at:Date.now()}));await rename(tmp,path);};
 const ps=join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),exec=promisify(execFile);
 try{
  const request=JSON.parse(await readFile(join(dir,'apply-request.json'),'utf8'));
  if(request.id!==id||Date.now()-request.at>60000)throw Error('Stale apply request');
  await waitAndApply({prepared:()=>updater.prepared(),publish,
   cancelled:async()=>{try{return JSON.parse(await readFile(join(dir,'apply-cancel.json'),'utf8')).id===id;}catch{return false;}},
   parentRunning:async()=>{try{process.kill(parent,0);return true;}catch{return false;}},
   inspect:async()=>{const {stdout}=await exec(ps,['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'tools/jinbao-launcher/platform.ps1'),'-StateDir',stateDir],{windowsHide:true,timeout:20000});return JSON.parse(stdout.replace(/^\uFEFF/,'')).running===true;},
   launch:async candidate=>{await new Promise((accept,reject)=>{const child=spawn(ps,['-NoProfile','-ExecutionPolicy','Bypass','-File',join(candidate,'tools/jinbao-launcher/start.ps1'),'-StateDir',stateDir],{detached:true,windowsHide:true,stdio:'ignore'});child.once('error',reject);child.once('spawn',()=>{child.unref();accept();});});},
  });
 }catch{await publish({state:'failed',message:'自动安装未完成，原版本和设置保留。请从原入口重新打开金宝。'});process.exitCode=1;}
}
