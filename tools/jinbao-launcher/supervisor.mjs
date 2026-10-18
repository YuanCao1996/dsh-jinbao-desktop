import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import {createPhoneAdb} from './phone-adb.mjs';

const exec = promisify(execFile);
export function parseDevices(output) {
  return output.split(/\r?\n/).slice(1).map(line => line.trim().split(/\s+/))
    .filter(row => row.length >= 2).map(([serial, status]) => ({ serial, status }));
}

// Only this instance's children are stopped. Do not use taskkill by process name.
export function createSupervisor({ root, stateDir, run = exec, spawnImpl = spawn, now = Date.now, signal, getPhoneEnabled=async()=>false, adbController }) {
  const adb = join(root, 'runtime/platform-tools/adb.exe');
  const phoneAdb=adbController??createPhoneAdb({adb,run,spawnImpl});
  const shutdown=new AbortController();
  const runSignal=signal?AbortSignal.any([signal,shutdown.signal]):shutdown.signal;
  const children = new Map();
  const retries = new Map();
  const stoppingChildren = new Set();
  let closed = false;
  let ticking = false;
  let phoneSerial = null;
  function start(key, script, env = {}) {
    if (closed || children.has(key) || (retries.get(key) ?? 0) > now()) return;
    const child = spawnImpl(process.execPath, [join(root, script)], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, JINBAO_LOG_DIR: join(stateDir, 'logs'), ...env },
    });
    children.set(key, child);
    const removed = () => {
      if (children.get(key) === child) children.delete(key);
      stoppingChildren.delete(child);
      retries.set(key, now() + 10000);
    };
    child.once('error', removed);
    child.once('exit', removed);
  }
  function stop(key) {
    const child = children.get(key);
    if (!child) return;
    children.delete(key);
    stoppingChildren.add(child);
    if (child.connected && typeof child.send === 'function') {
      child.send({ action: 'stop' }, error => { if (error) child.kill(); });
      const fallback = setTimeout(() => { if (stoppingChildren.has(child)) child.kill(); }, 5000);
      fallback.unref();
    } else child.kill();
  }
  return {
    async tick() {
      if (closed || ticking) return { status: 'checking' };
      ticking = true;
      try {
        start('lol', 'tools/lol-companion/collector.mjs');
        if(!await getPhoneEnabled()){stop('wzry');phoneSerial=null;await phoneAdb.close();return {status:'waiting',message:'等待进入游戏'};}
        if(closed)return {status:'stopped'};
        let devices;
        try {
          const result = await phoneAdb.run(['devices'], { windowsHide: true, timeout: 5000, maxBuffer: 8192, signal:runSignal });
          devices = parseDevices(result.stdout);
        } catch {
          stop('wzry'); return { status: 'adb-unavailable', message: '等待进入游戏；手机采集暂不可用' };
        }
        if(closed)return {status:'stopped'};
        const authorized = devices.filter(device => device.status === 'device');
        if (authorized.length !== 1) {
          stop('wzry');
          return { status: authorized.length > 1 ? 'multiple-devices' : devices.some(d => d.status === 'unauthorized') ? 'unauthorized' : 'waiting',
            message: authorized.length > 1 ? '连接了多台手机，请仅保留用于游戏的一台' : devices.some(d => d.status === 'unauthorized') ? '请在手机上允许 USB 调试；电脑游戏仍可检测' : '等待进入游戏' };
        }
        const serial = authorized[0].serial;
        if (phoneSerial !== serial) { stop('wzry'); phoneSerial = serial; }
        let appRunning = false;
        try {
          const result = await phoneAdb.run(['-s', serial, 'shell', 'pidof', 'com.example.jinbao'], { windowsHide: true, timeout: 5000, maxBuffer: 8192, signal:runSignal });
          appRunning = /^\d+(?:\s+\d+)*\s*$/.test(result.stdout.trim());
        } catch { /* Phone disconnected, or app not running. */ }
        if (closed) return { status: 'stopped' };
        if (appRunning) start('wzry', 'tools/desktop-release/capture-wzry.mjs', { JINBAO_ADB_SERIAL: serial, ...phoneAdb.env() });
        else stop('wzry');
        return { status: appRunning ? 'connected' : 'app-required', message: appRunning ? '等待进入游戏' : '手机已连接，请打开金宝 APP 并启动游戏识别' };
      } finally { ticking = false; }
    },
    async close() {
      closed = true;shutdown.abort();
      for (const key of children.keys()) stop(key);
      if (!stoppingChildren.size){await phoneAdb.close();return;}
      await Promise.all([...stoppingChildren].map(child => new Promise(resolve => {
        if (!stoppingChildren.has(child)) return resolve();
        const timer = setTimeout(resolve, 5500);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      })));
      await phoneAdb.close();
    },
  };
}
