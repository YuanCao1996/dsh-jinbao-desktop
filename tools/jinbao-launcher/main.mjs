import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rename, access, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { createSupervisor } from './supervisor.mjs';
import { installationCurrent, installationAction, createHostRecovery } from './installation.mjs';
import { createUpdater } from './update.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const stateDir = resolve(args.includes('--state') ? args[args.indexOf('--state') + 1] : join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'jinbao'));
const profiles = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles');
const ps = join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const platform = join(root, 'tools/jinbao-launcher/platform.ps1');
const shutdown = new AbortController();
const updater = createUpdater({ root, stateDir });
let pluginUpdatePending=false;
async function psRun(script, extra = []) {
  return exec(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...extra], { windowsHide: true, timeout: 60000, maxBuffer: 65536 });
}
async function inspect() { return JSON.parse((await psRun(platform, ['-StateDir', stateDir])).stdout.replace(/^\uFEFF/, '')); }
async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function publish(phase, message, extra = {}) {
  const path = join(stateDir, 'launcher-state.json');
  let update;
  try { update = JSON.parse(await readFile(join(stateDir, 'updates/status.json'), 'utf8')); } catch { /* First launch. */ }
  let version=null;
  try{version=JSON.parse(await readFile(join(root,'manifest.json'),'utf8')).version;}catch{}
  await writeFile(path + '.tmp', JSON.stringify({ phase, message, version, pluginUpdatePending, ...extra, update, updatedAt: Date.now() }));
  await rename(path + '.tmp', path);
}
export function settingsAddress(value) {
  if (!/^http:\/\/127\.0\.0\.1:[0-9]+\/#[a-f0-9]{64}$/.test(value)) throw Error('Invalid settings address');
  const url = new URL(value);
  return { origin: url.origin, nonce: url.hash.slice(1) };
}
async function status() {
  const link = (await readFile(join(stateDir, 'settings-link.txt'), 'utf8')).trim();
  const { origin, nonce } = settingsAddress(link);
  const response = await fetch(origin + '/api/status', { headers: { 'X-Jinbao-Setup': nonce }, redirect: 'error', signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(15000)]) });
  if (!response.ok) throw Error('Setup service not ready');
  const value = await response.json();
  if (typeof value.mode !== 'string' || typeof value.coachReady !== 'boolean') throw Error('Unexpected setup response');
  return { link, value };
}
async function localRequest(link, path) {
  const { origin, nonce } = settingsAddress(link);
  const response = await fetch(origin + '/api/' + path, { method: 'POST',
    headers: { 'X-Jinbao-Setup': nonce, 'Content-Type': 'application/json' }, body: '{}',
    redirect: 'error', signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(15000)]) });
  if (!response.ok) throw Object.assign(Error('Login not ready'), { status: response.status });
  return response.json();
}
async function main() {
  await mkdir(stateDir, { recursive: true });
  let host = await inspect();
  if (args.includes('--check')) {
    console.log(JSON.stringify({ desktopInstalled: !!host.desktop, desktopRunning: host.running,
      legacyOverlayRunning: !!host.legacyOverlay?.length,
      pluginInstalled: await exists(join(profiles, 'node_modules/dsh-onboarding/plugin.mjs')) }));
    return;
  }
  let stopping = false;
  const stop = () => { stopping = true; shutdown.abort(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let checkingStop = false;
  const stopWatcher = setInterval(async () => {
    if (checkingStop) return;
    checkingStop = true;
    try { if (await exists(join(stateDir, 'overlay-stopped'))) stop(); }
    finally { checkingStop = false; }
  }, 250);
  const supervisor = createSupervisor({ root, stateDir, signal: shutdown.signal, getPhoneEnabled:async()=>{try{return JSON.parse(await readFile(join(stateDir,'phone-capture.json'),'utf8')).enabled===true;}catch{return false;}} });
  let updateTask = updater.check(shutdown.signal);
  const updateTimer = setInterval(() => { updateTask = updater.check(shutdown.signal); }, 6 * 60 * 60 * 1000);
  let updateHealthy = false;
  let installed = false;
  const recovery = createHostRecovery();
  let loginOpened = false;
  let settingsOpened = false;
  let loginPolling = false;
  let lastAction = Date.now();
  let nextHostCheck = 0;
  let legacyActive = false;
  try {
    while (!stopping && !await exists(join(stateDir, 'overlay-stopped'))) {
      let action = '';
      try {
        const command = JSON.parse(await readFile(join(stateDir, 'launcher-control.json'), 'utf8'));
        if (command.at > lastAction) { lastAction = command.at; action = command.action; }
      } catch { /* No pending UI action. */ }
      if (action === 'download') await psRun(platform, ['-Action', 'open', '-Target', 'https://deepseek.com/harness/']);
      if (action === 'check-update') updateTask = updater.check(shutdown.signal);
      if (Date.now() > nextHostCheck) { host = await inspect(); nextHostCheck = Date.now() + 10000; }
      if (host.legacyOverlay?.length) {
        await psRun(platform, ['-Action', 'legacy-show']);
        // A developer host may launch its old overlay after our first check.
        // Yield our UI and owned collectors without touching that host or its config.
        legacyActive = true;
        await writeFile(join(stateDir, 'overlay-control.json'), JSON.stringify({ action: 'exit', at: Date.now() }));
        break;
      }
      if (!host.desktop) {
        await publish('install-required', '首次使用需要安装 DeepSeek Harness，安装后金宝会自动继续。', { action: 'download', actionLabel: '下载 DSH' });
        await sleep(2000); continue;
      }
      if(pluginUpdatePending&&!host.running)installed=false;
      const repairRequested=await exists(join(stateDir,'repair-pending.json'));
      if(repairRequested&&!host.running)installed=false;
      if (!installed) {
        const current = !repairRequested && await installationCurrent(root, profiles);
        const action=installationAction({current,hostRunning:host.running,pluginInstalled:await exists(join(profiles,'node_modules/dsh-onboarding/plugin.mjs'))});
        pluginUpdatePending=action==='defer';
        if (action==='wait') {
          await publish('install-required', '首次安装金宝扩展，请在方便时退出 DSH 一次，金宝将完成配置。');
          await sleep(2000); continue;
        }
        if (action==='install') {
          await publish('starting', '正在安装金宝扩展…');
          await psRun(join(root, 'tools/desktop-release/install.ps1'), ['-NodePath', process.execPath, '-ProfilesRoot', profiles, '-StateDir', stateDir, '-KeepOverlay']);
          await rm(join(stateDir,'repair-pending.json'),{force:true});
          await writeFile(join(stateDir,'maintenance-status.json'),JSON.stringify({state:'complete',message:'扩展已安装或修复完成。'}));
        }
        if (stopping) break;
        installed = true;
        try{
          await psRun(platform, ['-Action', 'shortcut', '-Target', join(root, 'start-jinbao.vbs'),
            ...(process.env.JINBAO_SHORTCUT_DIR?['-ShortcutDirectory',process.env.JINBAO_SHORTCUT_DIR]:[])]);
        }catch{ /* The portable package entry remains usable when a shortcut cannot be written. */ }
      }
      if (stopping) break;
      if (recovery.shouldStart(host.running)) {
        await publish('starting', '正在启动 DSH 和教练服务…');
        try { await psRun(platform, ['-Action', 'open', '-Target', host.desktop,
          ...(process.env.JINBAO_DSH_USER_DATA_DIR?['-DesktopUserDataDir',process.env.JINBAO_DSH_USER_DATA_DIR]:[])]); }
        catch { await publish('service-error', 'DSH 启动失败，金宝会稍后重试；也可手动打开 DSH。'); }
      }
      try {
        const { link, value } = await status();
        if(!settingsOpened){await psRun(platform,['-Action','open','-Target',link]);settingsOpened=true;loginOpened=true;}
        if (value.coachReady && !updateHealthy) { await updater.healthy().catch(() => {}); updateHealthy = true; }
        if (loginPolling) {
          try { const result = await localRequest(link, 'login/poll'); if (result.status === 'approved') loginPolling = false; }
          catch (error) { if (error.status === 410) loginPolling = false; }
        }
        const collection = await supervisor.tick();
        if (!value.coachReady) await publish('starting', '等待教练服务就绪…');
        else if (value.mode !== 'byok' && !value.account) {
          await publish(value.accountError && value.accountError !== 401 ? 'connection-error' : 'login-required',
            value.accountError && value.accountError !== 401 ? '云端连接失败，请检查网络后重试' : '请在网页完成邮箱登录；已在后台等待游戏', { action: 'login', actionLabel: '邮箱登录', collection });
          if (!loginOpened || action === 'login') {
            await psRun(platform, ['-Action', 'open', '-Target', link]);
            loginOpened = true;
          }
        } else if (value.mode === 'cloud' && !value.account?.features?.model) {
          await publish('quota-required', '官方模型未开通或额度不足，可在设置查看权益或配置自己的 API Key', { action: 'settings', actionLabel: '打开设置', collection });
        } else if(value.mode==='byok'&&!value.byokConfigured){
          await publish('model-required','请在设置中保存可用的模型 API Key',{action:'settings',actionLabel:'打开设置',collection});
        } else if(value.matchActive){
          if(value.activeGame==='wzry'&&collection.status!=='connected')await publish('capture-lost','手机采集已断开，正在等待重新连接',{collection});
          else await publish('playing','正在对局 · '+(value.activeGame==='lol'?'英雄联盟':'王者荣耀'),{collection});
        } else await publish('waiting', collection.message, { collection });
        if (action === 'settings') await psRun(platform, ['-Action', 'open', '-Target', link]);
      } catch {
        if (!stopping) await publish('service-error', '教练服务尚未就绪，请检查 DSH 是否正常启动；网页“维护与诊断”可查看状态。');
      }
      await sleep(3000, undefined, { signal: shutdown.signal }).catch(() => {});
    }
  } finally {
    clearInterval(stopWatcher); clearInterval(updateTimer); shutdown.abort(); await updateTask; await supervisor.close();
    await publish(legacyActive ? 'legacy-active' : 'stopped', legacyActive
      ? '正在使用 DSH 已启动的金宝悬浮窗，下载版未接管现有开发配置。' : '金宝已退出');
  }
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch(async () => { await publish('error', '启动失败，请检查 DSH 安装，或在设置网页查看维护与诊断'); process.exitCode = 1; });
}
