import {execFile}from'node:child_process';import{promisify}from'node:util';import{join}from'node:path';
import{bootstrapHost}from'../jinbao-launcher/host-bootstrap.mjs';
export function createNativeInstaller({root,stateDir,install=bootstrapHost,run=promisify(execFile)}){
 const lifetime=new AbortController();let task=null,status={state:'idle',message:'官方服务无需安装；自己的 API Key 模式可复用已安装的 DSH。'};
 return{status:()=>({...status}),start(){
  if(task)return{message:'正在准备 DSH，请查看安装进度。'};
  status={state:'downloading',message:'正在下载 DSH 官方安装程序…'};
  task=install({stateDir,signal:lifetime.signal,onProgress:progress=>{status={state:progress.stage==='install'?'installing':'downloading',received:progress.received??0,total:progress.total??0,message:progress.stage==='install'?'请完成 DSH 官方安装窗口中的操作。':'正在下载 DSH 官方安装程序…'};},runInstaller:installer=>run(join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'tools/jinbao-launcher/install-host.ps1'),'-InstallerPath',installer],{windowsHide:true,timeout:15*60*1000,signal:lifetime.signal})}).then(()=>{status={state:'ready',message:'DSH 安装已完成，请保存自有模型设置。'};},()=>{status={state:'failed',message:'DSH 安装未完成，请重试；官方云端服务仍可使用。'};}).finally(()=>{task=null;});
  return{message:'已开始下载 DSH 官方安装程序，进度将在此页面显示。'};
 },async close(){lifetime.abort();await task;}};
}
