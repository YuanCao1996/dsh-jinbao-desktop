import {readFile,mkdir,copyFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,relative,dirname,join,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertReleaseRuntime} from '../desktop-release/runtime-policy.mjs';

// Separate preview artifact: never changes stable release metadata or update feeds.
export async function buildPreview({root,out,runtime=process.execPath}) {
 const updateVersion='0.2.2',version=updateVersion+'-standalone-preview.1';
 const files=new Set();
 async function include(name) {
  const path=resolve(root,name),local=relative(root,path);
  if(local.startsWith('..')||local.startsWith(sep))throw Error('Asset outside project');
  if(files.has(local))return;
  files.add(local);
  if(!/\.(mjs|js)$/.test(local))return;
  const source=await readFile(path,'utf8');
  for(const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g)) {
   const spec=match[1];
   if(spec.startsWith('node:'))continue;
   if(!spec.startsWith('.'))throw Error('Standalone preview has an external dependency: '+spec);
   await include(relative(root,resolve(dirname(path),spec)));
  }
 }
 for(const name of ['tools/cloud-desktop/main.mjs','tools/cloud-desktop/entry.mjs','tools/lol-companion/collector.mjs'])await include(name);
 for(const name of [
  'tools/cloud-desktop/protect.ps1','tools/cloud-desktop/instance.ps1','tools/dsh-onboarding/settings.html',
  'tools/dsh-coach-server/capture-game.ps1','tools/lol-companion/capture-augments.ps1','tools/lol-companion/augment-names.json',
  'tools/jinbao-launcher/platform.ps1','tools/jinbao-launcher/legacy-overlay.ps1','tools/jinbao-launcher/legacy-window.ps1',
  'tools/jinbao-launcher/update-public.pem','tools/jinbao-launcher/extract-update.ps1',
  'tools/jinbao-launcher/install-host.ps1',
  'tools/game-observation/windows/worker.ps1','tools/game-observation/windows/WindowCapture.cs',
  ...['start-overlay','strategy-overlay','confirmation-countdown','overlay-modes','overlay-ui','overlay-playback'].map(n=>'tools/desktop-release/'+n+'.ps1'),
  'LICENSE','third-party/node-LICENSE.txt'
 ])await include(name);
 await mkdir(out); // Deliberately refuses to overwrite an existing artifact.
 for(const name of files){const target=join(out,name);await mkdir(dirname(target),{recursive:true});await copyFile(join(root,name),target);}
 await mkdir(join(out,'runtime'));
 await copyFile(runtime,join(out,'runtime/node.exe'));
 await copyFile(join(root,'third-party/node-LICENSE.txt'),join(out,'runtime/LICENSE'));
 await writeFile(join(out,'package.json'),JSON.stringify({name:'jinbao-cloud-preview',private:true,type:'module',version}));
 await writeFile(join(out,'tools/dsh-onboarding/release-notes.json'),JSON.stringify({version:version+' (独立预览)',notes:"独立桌面版预览更新：\n• 修复聊天未抢占后台任务、运行时启动与会话关闭时的竞争。\n• 修复加载页被当作对局结束、战况建议过期后不再触发的问题。\n• 出装任务保留原要求；已确认/推测海克斯通过工具事实分开提供，去除冗余原始字段。\n• 云端轮询短暂断线重试原任务，超时单独提示；自有 Key 保留认证错误，换局中断旧请求。\n• 同一设备只需首次配对；现有有效配对自动升级，重启、更新和暂停同步后自动重连。\n• 新增明确的解除配对入口；长期配对凭据只允许本机同步，不能调用模型账号。\n• 默认官方服务使用云端 DSH，无需安装宿主；已有体验名额会自动开通，保留邮箱登录。\n• 自有 API Key 模式复用本机 DSH 原生 Agent、会话、工具和压缩，无需另开 DSH 窗口。\n• 独立签名更新通道，支持进度、安装和启动失败回退。\n• 配对码同步与手机主动聊天；手动聊天优先于自动建议。\n• LoL 自动采集；已有王者及其他游戏日志可按需接入，通用窗口支持按需看图和受预算约束的截图计划。\n• 团队局势估计随时间与击杀变化，海克斯识别提速。\n• 显示模式放入设置、退出确认、Ctrl+Alt+方向键。\n• 保留本局日志按需检索，中文长会话通过 DSH 原生压缩控制请求大小。\n\n仍为预览版；真实对局效果和启发式估计尚待实战验收。"}));
 await writeFile(join(out,'start-preview.vbs'),[
  'Option Explicit','Dim shell, fs, root, command','Set shell = CreateObject("WScript.Shell")',
  'Set fs = CreateObject("Scripting.FileSystemObject")','root = fs.GetParentFolderName(WScript.ScriptFullName)',
  'command = Chr(34) & root & "\\runtime\\node.exe" & Chr(34) & " " & Chr(34) & root & "\\tools\\cloud-desktop\\entry.mjs" & Chr(34) & " --collect --coach"',
  'shell.Run command, 0, False',''
 ].join('\r\n'));
 await writeFile(join(out,'开始使用.cmd'),'@echo off\r\nwscript.exe "%~dp0start-preview.vbs"\r\n');
 await writeFile(join(out,'README.md'),[
  '# 金宝云端预览版','',
  '## 开始使用','',
  '1. 先退出其他金宝悬浮窗，将压缩包完整解压到新文件夹。',
  '2. 双击“开始使用.cmd”，悬浮窗和设置网页会自动打开。',
  '3. 官方服务默认自动尝试已开放的免登录体验名额；也可使用邮箱登录。进入游戏即可，无需安装 Node.js 或 DSH Desktop。',
  '4. 更新预览包时，确认退出旧窗口后，从新文件夹启动。登录保存在当前用户的 .jinbao-cloud-preview 目录中，同一 Windows 用户无需因换包重新登录（凭据有效时）。','',
  '## 悬浮窗操作','',
  '- 设置 → 显示与播报：大框、窄条、字幕、横向滚动或静默小球。',
  '- Ctrl+Alt+↑：展开；Ctrl+Alt+↓：收起并吸附右侧。',
  '- Ctrl+Alt+← / →：上一页 / 下一页。',
  '- 设置 → 快捷键：查看组合；若提示已被占用，可继续使用按钮操作。',
  '- 点击叉号后确认才退出，取消后继续运行。','',
  '## 数据说明','',
  '胜率页顶部为随时间和击杀比分变化的局势估计；它未经结果校准，不是统计胜率。英雄表格仍显示资料库的样本胜率与强度。海克斯三选一按英雄适配排名展示，重掷经稳定识别后更新。','',
  '## 模型调用方式','',
  '默认使用金宝官方云端服务，无需安装 DSH Desktop。设置中可改为自己的 API Key：填写模型地址、模型名及密钥；需要本机安装 DSH Desktop，金宝会读取其原生 Agent 依赖到独立缓存，无需同时启动 DSH 窗口，不修改原 DSH 配置。自定义安装位置可填写程序路径。密钥按当前 Windows 用户加密保存，不发送给金宝服务器。攻略资料库检索仍需独立授权。','',
  '设置页支持检查、后台下载和安装独立桌面版更新，对局中不会安装。签名与文件校验失败时继续使用原版本，新版启动失败会回退。此包使用独立更新通道，不会安装旧版 DSH 插件包。','',
  '真实对局仍待验收。此包未正式发布，正式版继续使用原入口。',''
 ].join('\n'));
 const report={version,updateVersion,preview:true,runtime:'standalone',requiresDshDesktop:false,localModeRequiresInstalledDsh:true,bundledRuntime:true,externalPackages:0,adbIncluded:false,files:files.size+9};
 await writeFile(join(out,'preview-manifest.json'),JSON.stringify(report,null,2));
 const manifest={version:updateVersion,runtime:'standalone',files:[]};
 async function inventory(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())await inventory(path);else{const bytes=await readFile(path);manifest.files.push({path:relative(out,path).replaceAll('\\','/'),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}}}
 await inventory(out);await writeFile(join(out,'manifest.json'),JSON.stringify(manifest));
 return report;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 assertReleaseRuntime(process.version);
 if(process.platform!=='win32')throw Error('Windows preview build requires Windows');
 const root=fileURLToPath(new URL('../../',import.meta.url));
 if(!process.argv[2])throw Error('Supply a new output directory');
 console.log(JSON.stringify(await buildPreview({root,out:resolve(process.argv[2])})));
}
