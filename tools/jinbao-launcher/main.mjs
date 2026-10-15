import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rename, access, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { createSupervisor } from './supervisor.mjs';
import { installationCurrent, createHostRecovery } from './installation.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const stateDir = resolve(args.includes('--state') ? args[args.indexOf('--state') + 1] : join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'jinbao'));
const profiles = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles');
const ps = join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const platform = join(root, 'tools/jinbao-launcher/platform.ps1');
const shutdown = new AbortController();
async function psRun(script, extra = []) {
  return exec(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...extra], { windowsHide: true, timeout: 60000, maxBuffer: 65536 });
}
async function inspect() { return JSON.parse((await psRun(platform)).stdout.replace(/^\uFEFF/, '')); }
async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function publish(phase, message, extra = {}) {
  const path = join(stateDir, 'launcher-state.json');
  await writeFile(path + '.tmp', JSON.stringify({ phase, message, ...extra, updatedAt: Date.now() }));
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
  const supervisor = createSupervisor({ root, stateDir, signal: shutdown.signal });
  let installed = false;
  const recovery = createHostRecovery();
  let loginOpened = false;
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
      if (Date.now() > nextHostCheck) { host = await inspect(); nextHostCheck = Date.now() + 10000; }
      if (host.legacyOverlay?.length) {
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
      if (!installed) {
        const current = await installationCurrent(root, profiles);
        if (!current && host.running) {
          await publish('restart-required', '请保存工作并关闭 DSH，金宝将自动配置并重新启动。');
          await sleep(2000); continue;
        }
        if (!current) {
          await publish('starting', '正在安装金宝扩展…');
          await psRun(join(root, 'tools/desktop-release/install.ps1'), ['-NodePath', process.execPath, '-ProfilesRoot', profiles, '-StateDir', stateDir, '-KeepOverlay']);
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
        if (loginPolling) {
          try { const result = await localRequest(link, 'login/poll'); if (result.status === 'approved') loginPolling = false; }
          catch (error) { if (error.status === 410) loginPolling = false; }
        }
        const collection = await supervisor.tick();
        if (!value.coachReady) await publish('starting', '等待教练服务就绪…');
        else if (value.mode !== 'byok' && !value.account) {
          await publish(value.accountError && value.accountError !== 401 ? 'connection-error' : 'login-required',
            value.accountError && value.accountError !== 401 ? '云端连接失败，请检查网络后重试' : '请完成金宝登录；已在后台等待游戏', { action: 'login', actionLabel: '微信登录', collection });
          if (!loginOpened || action === 'login') {
            if (value.wechatEnabled) {
              const login = await localRequest(link, 'login/wechat/start');
              const authorize = new URL(login.authorizationUrl);
              if (authorize.origin !== 'https://open.weixin.qq.com' || authorize.pathname !== '/connect/qrconnect') throw Error('Unexpected authorization link');
              await psRun(platform, ['-Action', 'open', '-Target', authorize.href]); loginPolling = true;
            } else await psRun(platform, ['-Action', 'open', '-Target', link]);
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
        if (!stopping) await publish('service-error', '教练服务尚未就绪，请检查 DSH 是否正常启动，或从高级维护菜单查看诊断。');
      }
      await sleep(3000, undefined, { signal: shutdown.signal }).catch(() => {});
    }
  } finally {
    clearInterval(stopWatcher); await supervisor.close();
    await publish(legacyActive ? 'legacy-active' : 'stopped', legacyActive
      ? '正在使用 DSH 已启动的金宝悬浮窗，下载版未接管现有开发配置。' : '金宝已退出');
  }
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch(async () => { await publish('error', '启动失败，请从高级维护菜单检查安装与服务状态'); process.exitCode = 1; });
}
