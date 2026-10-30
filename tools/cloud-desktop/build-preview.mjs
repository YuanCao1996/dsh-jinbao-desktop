import {readFile,mkdir,copyFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,relative,dirname,join,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertReleaseRuntime} from '../desktop-release/runtime-policy.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

// Separate preview artifact: never changes stable release metadata or update feeds.
export async function buildPreview({root,out,runtime=process.execPath}) {
 const updateVersion='0.2.4',version=updateVersion+'-standalone-preview.1';
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
  'tools/cloud-desktop/protect.ps1','tools/cloud-desktop/instance.ps1','tools/cloud-desktop/audio-player.ps1','tools/cloud-desktop/synthesize-speech.ps1','tools/dsh-onboarding/settings.html',
  'tools/team-room/page.html','tools/team-room/page.css','tools/team-room/page.mjs',
  'tools/dsh-coach-server/capture-game.ps1','tools/lol-companion/capture-augments.ps1','tools/lol-companion/augment-names.json',
  'tools/lol-companion/AllyUltimateVision.cs','tools/lol-companion/observe-ally-ultimates.ps1',
  'tools/jinbao-launcher/platform.ps1','tools/jinbao-launcher/legacy-overlay.ps1','tools/jinbao-launcher/legacy-window.ps1',
  'tools/jinbao-launcher/update-public.pem','tools/jinbao-launcher/extract-update.ps1',
  'tools/jinbao-launcher/install-host.ps1',
  'tools/game-observation/windows/worker.ps1','tools/game-observation/windows/WindowCapture.cs',
  ...['start-overlay','strategy-overlay','confirmation-countdown','overlay-modes','overlay-ui','overlay-playback','capture-coordination','window-pixels','agent-activity'].map(n=>'tools/desktop-release/'+n+'.ps1'),
  'LICENSE','third-party/node-LICENSE.txt','tools/cloud-desktop/Launcher.cs'
 ])await include(name);
 await mkdir(out); // Deliberately refuses to overwrite an existing artifact.
 for(const name of files){const target=join(out,name);await mkdir(dirname(target),{recursive:true});await copyFile(join(root,name),target);}
 await mkdir(join(out,'runtime'));
 await copyFile(runtime,join(out,'runtime/node.exe'));
 await copyFile(join(root,'third-party/node-LICENSE.txt'),join(out,'runtime/LICENSE'));
 await writeFile(join(out,'package.json'),JSON.stringify({name:'jinbao-cloud-preview',private:true,type:'module',version}));
 await writeFile(join(out,'tools/dsh-onboarding/release-notes.json'),JSON.stringify({version:version+' (独立预览)',notes:"独立桌面版修复更新（实战候选 r23）：\n• 通用窗口识别回写：游戏名、模式、版本和阶段区分待核实、多帧印证与用户确认，复用已有看图结果，不增加识别模型任务。\n• 绑定实际交给Agent的截图回执，拒绝重复、过期、乱序及旧会话结果；多帧核实结算/新局后隔离会话，不把旧局回复带入新局。\n• 设置页新增游戏身份修正与“当前窗口开始新一局”；跨局清空阶段、模式与画面回执，窗口继续观察。\n• 修复选择窗口期间点击停止后可能重新开始观察的竞态；通用检索使用已识别游戏、模式和版本。保留60秒自动分析冷却和短播报规则。\n\nr22 修复\n• 低频优先：战况与后台出装共用自动分析额度，每次自动任务结束后冷却60秒；语音忙或待播时不再发起自动任务，不堆积任务队列。\n• 每次正常语音结束后至少安静45秒，每条最多60字、单段播报；超长正文不另调模型摘要，无法提取完整短句就不播。\n• 自动语音不排队；手动聊天只留最新一条待播，20秒过期丢弃。紧急自动消息也不豁免限频，保留完整文字与本地实时海克斯排名。\n• 设置页显示安静间隔，诊断记录限频、超长与过期丢弃；角色试听仅由用户明确点击触发。\n\nr21 修复\n• 语音取消等待本机播放/合成子进程真正关闭后才交接，防止快速换角色时短暂重叠或残留。\n• 关闭聊天朗读只取消聊天语音，保留正在播放和排队的战况建议；未改变设置的保存不重置正在播放的内容。\n• 增加静音WAV实际播放、取消、进程消失和真实角色切换顺序测试，不在测试时发出可听语音。\n\nr20 修复\n• 增加 App 同款四角色：金宝、柳如风、王霸天、铁汁，复用 CosyVoice 模型音色，角色同时影响战况与聊天表达。\n• 新增角色与语音设置、试听、官方语音和自有 DashScope 语音 Key；长期密钥不进入安装包，自有 Key 本机加密保存直连。\n• 战况与聊天分段排队播报，不随意打断；切局、换角色、关闭、过期或建议撤销时停止旧语音。语音故障保留文字并记录脱敏诊断。\n\nr19 修复\n• 默认本机记录实战诊断：串联Agent排队、工具调用、失败耗时、自动教练跳过原因、OCR和窗口心跳，不记录正文、玩家名、凭据或截图。\n• 维护与诊断新增问题时间标记和脱敏导出；包含最近三次启动，重启后可保留故障线索，限量轮转不上传。\n\nr18 修复\n• 自动策略的失败状态和重试冷却绑定本局；上一局失败不再污染或延迟新局建议。\n• 发布前再次核对游戏、对局、采集状态与时间；采集暂停或画面过期时不播报旧建议，读取上下文期间切局不再提交旧任务。\n\nr17 修复\n• 按住TAB显示计分板时不误报选择完成；释放后保留原轮次与刷新次数。\n• 修复截图心跳和回执写入被读锁阻挡时可能终止悬浮窗的问题，临时IO冲突可恢复并记录计数。\n• 心跳损坏或过期时核验真实窗口互斥锁，避免误把悬浮窗截入；陈旧PID不再误阻断截图。\n• 黑帧回退拒绝空白结果并释放截图租约，不把失败截图当作面板关闭。\n• 长时间失去画面后重新识别候选；稳定的新轮次不会被旧刷新次数卡住，过期或重复帧不作选择确认。\n• 直播兼容：优先读取游戏窗口自身画面，无需更改悬浮窗录制属性；黑帧时回退并记录方式。\n• 海克斯选择后穿插快速标题OCR，并周期保留完整HUD与聊天识别；降低重掷确认延迟。\n• 攻略搜索补全海斗模式，给备用通道保留时间；明确区分没有匹配结果与网络失败。\n• 临时模型故障仅重试一次，每次仍验证授权与额度；高频自动建议使用低延迟推理参数。\n• 资料按一次逻辑查询计量，复用缓存；不因内部多数据集查询多扣次数。\n• 战况播报优先动作、对象、触发条件和理由，减少复述面板；未知购买机会和机制保持保守。\n• 实战稳定性：截图时使用排除捕获，屏幕上的悬浮窗不闪烁；截图排除部分失败时恢复设置。\n• 悬浮窗异常退出后限次恢复，保留诊断日志；用户确认退出后不会重新拉起，恢复保留显示模式。\n• 云端资料检索受限不再终止整个分析，重复查询复用缓存；失败任务回执正常清理。\n• 桌面端完整正文不会因短答压缩失败而丢失；过长、未完成或违反回复规则的内容仍保留限制。\n• 生命周期修复：切换模型先关闭旧引擎，退出等待初始化资源释放；停止网页新请求并排空已接受的保存，单项清理报错仍继续释放其他资源。\n• 调度联动修复：后台队列满时优先聊天，云端等待取消任务真正退出后交接；正常打断不再触发15/30秒失败冷却，对局结束后不再追加过期出装建议。\n• 直播过程稳定性：过滤已结束任务的迟到事件，清理旧草稿，显示重连状态；长草稿保留最新完整内容，失败不再标记为完成。\n• 新增直播展示开关：大框战况页实时显示真实工具调用、耗时及公开回答草稿，默认关闭；不展示原始推理，不回灌上下文。\n• 历史日志回放修复：加载结束进入对局；兼容旧阵容/装备字段，避免重复开局清空同局海克斯。\n• 暂未识别本人时也查询已知双方英雄胜率，不冒认玩家英雄。\n• 使用原生 jinbao.exe 启动，不再执行 VBS；保留旧更新器要求的纯注释占位文件。\n• 修复强化方案因无关散件变化被撤销、战况长期等待；三选一不再吞掉同时发生的已选强化任务。\n• 自动教练不再反复污染手动聊天历史；中文长会话继续使用 DSH 原生压缩和本局日志按需检索。\n• 胜率与英雄 Top10 基础查询独立于自主工具检索额度；英雄、Top10与候选空结果均可重试，海克斯查询优先。\n• 装备动态仅记录成装，敌方成装变化触发针对性建议；海克斯方案与装备建议联动战况。\n• 修复中文交互确认乱码、短暂关闭强化面板被误判为新轮次；独立OCR双重确认的单槽重掷立即更新。\n• 截图期间同时避让主窗、确认弹窗和设置菜单，拷贝像素后立即恢复。\n• 新增 Ctrl+Shift+F7/F8/F9/F10 备用快捷键及注册、输入诊断。\n• 新增实验性队友大招画面提醒：核对我方头像、连续识别就绪标记，过滤死亡队友；隐藏或未知时不猜冷却。\n• 保留用户记忆、邮箱登录、首次配对与独立签名更新。\n\n仍为预览版。原生入口未作代码签名，尚未通过用户所用杀毒软件复测；HUD 多布局及游戏前台输入仍需实战验收。"}));
 const compiler=join(process.env.SystemRoot??'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');
 await promisify(execFile)(compiler,['/nologo','/target:winexe','/optimize+','/reference:System.Windows.Forms.dll','/out:'+join(out,'jinbao.exe'),join(root,'tools/cloud-desktop/Launcher.cs')],{windowsHide:true});
 // Old signed-update verifiers require this filename. Keep only an inert
 // comment during migration; neither launcher nor CMD ever executes it.
 await writeFile(join(out,'start-preview.vbs'),'Rem Compatibility marker only. Start Jinbao.exe. No executable statements.\r\n');
 await writeFile(join(out,'开始使用.cmd'),'@echo off\r\nstart "" "%~dp0jinbao.exe"\r\n');
 await writeFile(join(out,'README.md'),[
  '# 金宝云端预览版','',
  '## 开始使用','',
  '1. 先退出其他金宝悬浮窗，将压缩包完整解压到新文件夹。',
  '2. 双击“开始使用.cmd”，悬浮窗和设置网页会自动打开。',
  '3. 官方服务默认自动尝试已开放的免登录体验名额；也可使用邮箱登录。进入游戏即可，无需安装 Node.js 或 DSH Desktop。',
  '4. 更新预览包时，确认退出旧窗口后，从新文件夹启动。登录保存在当前用户的 .jinbao-cloud-preview 目录中，同一 Windows 用户无需因换包重新登录（凭据有效时）。','',
  '## 悬浮窗操作','',
  '- 设置 → 直播展示：可开启智能体过程，仅在大框战况页显示；默认关闭。',
  '- 设置 → 显示与播报：大框、窄条、字幕、横向滚动或静默小球。',
  '- Ctrl+Alt+↑：展开；Ctrl+Alt+↓：收起并吸附右侧。',
  '- Ctrl+Alt+← / →：上一页 / 下一页。',
  '- 设置 → 快捷键：查看组合；若提示已被占用，可继续使用按钮操作。',
  '- 点击叉号后确认才退出，取消后继续运行。','',
  '## 通用游戏观察','',
  '设置 → 游戏与观察 → 其他电脑游戏：选择窗口并授权观察。已有日志也可从同页选择读取；本次多帧身份回写与自动分局主要适用于窗口看图路径。',
  '身份显示待核实、多帧印证或用户确认；已有看图结果会持续回写，不单独增加模型请求。游戏身份与模式不确定时不套用LoL规则。',
  '重复核实进入对局或结算时自动隔离会话；低频观察可能漏过快速结算，此时可点“当前窗口开始新一局”。旧日志保留，窗口继续观察，新局重新核实模式。身份不准可手动确认。当前并不保证任意游戏都能自动分局或给出正确策略。','',
  '## 角色与语音','',
  '在设置网页的“角色与语音”选择金宝、柳如风、王霸天或铁汁，并试听角色介绍。角色影响下一次战况和聊天的表达；语音播报默认关闭，可开启战况播报及聊天朗读。沿用旧版本已开启的语音开关。',
  '官方语音使用电脑的金宝登录；自有 DashScope 语音 Key 可独立配置并本机直连，语音 Key 独立于大模型 Key。四个角色使用与 App 相同的 CosyVoice 音色，不用 Windows 默认声音冒充。',
  '低频优先：自动分析任务（战况和后台出装共用）结束后至少冷却60秒，语音忙或待播时不发起自动分析。正常播报结束后至少安静45秒，每条最多60字、单段。自动建议不排队；手动聊天只留最新一条待播，20秒过期丢弃。长正文不另调模型摘要，无法提取完整短句就不播；完整文字保留。本地OCR与海克斯排名不受模型限频影响。用户主动提问不受自动任务额度限制，明确点击的角色试听可直接播放。','',
  '## 测试与诊断','',
  '每次启动自动记录本机诊断。设置网页 → 维护与诊断，可查看记录状态；发现异常时选择问题类型并点击“标记问题时间”，测试结束点击“导出诊断记录”。导出包含最近三次启动，不含聊天正文、玩家名、凭据或截图，不自动上传。诊断目录为当前用户 .jinbao-cloud-preview/diagnostics，最多保留10次启动，每次事件约2MB。异常标记只是排查线索，不代表游戏画面或建议质量已验收。','',
  '## 数据说明','',
  '胜率页顶部为随时间和击杀比分变化的局势估计；它未经结果校准，不是统计胜率。英雄表格仍显示资料库的样本胜率与强度。海克斯三选一按英雄适配排名展示，重掷经稳定识别后更新。','',
  '## 模型调用方式','',
  '默认使用金宝官方云端服务，无需安装 DSH Desktop。设置中可改为自己的 API Key：填写模型地址、模型名及密钥；需要本机安装 DSH Desktop，金宝会读取其原生 Agent 依赖到独立缓存，无需同时启动 DSH 窗口，不修改原 DSH 配置。自定义安装位置可填写程序路径。密钥按当前 Windows 用户加密保存，不发送给金宝服务器。攻略资料库检索仍需独立授权。','',
  '设置页支持检查、后台下载和安装独立桌面版更新，对局中不会安装。签名与文件校验失败时继续使用原版本，新版启动失败会回退。此包使用独立更新通道，不会安装旧版 DSH 插件包。','',
  '真实对局仍待验收。此包未正式发布，正式版继续使用原入口。',''
 ].join('\n'));
 const report={version,updateVersion,preview:true,runtime:'standalone',requiresDshDesktop:false,localModeRequiresInstalledDsh:true,bundledRuntime:true,externalPackages:0,adbIncluded:false,files:files.size+10};
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
