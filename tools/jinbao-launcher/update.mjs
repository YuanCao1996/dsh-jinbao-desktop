import { createHash, randomUUID, verify } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, open, unlink, readdir, lstat, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const UPDATE_FEED = 'https://api.jinbaoai.top/downloads/dsh/latest.json';
const MAX_ARCHIVE = 160 * 1024 * 1024;
const MAX_EXPANDED = 300 * 1024 * 1024;
const exec = promisify(execFile);
const moduleDir = fileURLToPath(new URL('.', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function compareVersions(a, b) {
  const parts = value => {
    if (typeof value !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value)) throw Error('Invalid release version');
    return value.split('.').map(Number);
  };
  const left = parts(a), right = parts(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}

export function verifyRelease(envelope, publicKey) {
  if (!envelope || typeof envelope.payload !== 'string' || envelope.payload.length > 12000 || typeof envelope.signature !== 'string') throw Error('Invalid release envelope');
  const payload = Buffer.from(envelope.payload, 'base64');
  const signature = Buffer.from(envelope.signature, 'base64');
  if (payload.toString('base64') !== envelope.payload || signature.length !== 64 || !verify(null, payload, publicKey, signature)) throw Error('Invalid release signature');
  const release = JSON.parse(payload);
  compareVersions(release.version, release.version);
  if (release.url !== `https://api.jinbaoai.top/downloads/dsh/v${release.version}/jinbao-desktop-windows.zip` ||
      !Number.isSafeInteger(release.bytes) || release.bytes <= 0 || release.bytes > MAX_ARCHIVE ||
      !/^[a-f0-9]{64}$/.test(release.sha256) || !/^[a-f0-9]{64}$/.test(release.manifestSha256)) throw Error('Invalid release metadata');
  return release;
}

function safeRelative(path) {
  return typeof path === 'string' && path.length > 0 && !path.includes('\\') && !path.includes(':') &&
    !path.includes('\0') && !path.startsWith('/') && !path.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p));
}

export async function verifyPackage(root, release) {
  const manifestBytes = await readFile(join(root, 'manifest.json'));
  if (manifestBytes.length > 2 * 1024 * 1024 || digest(manifestBytes) !== release.manifestSha256) throw Error('Package manifest mismatch');
  const manifest = JSON.parse(manifestBytes);
  if (manifest.version !== release.version || !Array.isArray(manifest.files) || manifest.files.length > 5000) throw Error('Invalid package manifest');
  const expected = new Set(['manifest.json']); let total = 0;
  for (const item of manifest.files) {
    if (!safeRelative(item.path) || expected.has(item.path.toLowerCase()) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[a-f0-9]{64}$/.test(item.sha256)) throw Error('Unsafe package entry');
    expected.add(item.path.toLowerCase()); total += item.bytes;
    if (total > MAX_EXPANDED) throw Error('Expanded package too large');
  }
  const found = new Set();
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw Error('Package contains a link');
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const name = relative(root, path).replaceAll('\\', '/').toLowerCase();
        if (!expected.has(name) || found.has(name)) throw Error('Unexpected package file');
        found.add(name);
      } else throw Error('Unsupported package file');
    }
  }
  await walk(root);
  if (found.size !== expected.size) throw Error('Package files missing');
  for (const item of manifest.files) {
    const path = join(root, item.path);
    if ((await lstat(path)).size !== item.bytes || digest(await readFile(path)) !== item.sha256) throw Error('Package file mismatch');
  }
  for (const required of ['runtime/node.exe','start-jinbao.vbs','tools/jinbao-launcher/start.ps1','tools/jinbao-launcher/main.mjs','tools/jinbao-launcher/update.mjs']) {
    if (!found.has(required.toLowerCase())) throw Error('Incomplete launcher package');
  }
  return manifest;
}

async function atomicJson(path, value) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
}

async function readJson(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } }
async function boundedResponse(response, maximum) {
  if (!response.ok || !response.body) throw Error('Update service unavailable');
  let bytes = 0; const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.length; if (bytes > maximum) throw Error('Update metadata too large'); chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function extractArchive(archive, destination) {
  const ps = join(process.env.SystemRoot ?? 'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  await exec(ps, ['-NoProfile','-ExecutionPolicy','Bypass','-File',join(moduleDir,'extract-update.ps1'),'-Archive',archive,'-Destination',destination], { windowsHide: true, timeout: 120000, maxBuffer: 16384 });
}

export function createUpdater({ root, stateDir, fetchImpl = fetch, publicKey, extract = extractArchive, now = Date.now }) {
  const updates = join(resolve(stateDir),'updates');
  let busy = false;
  async function key() { return publicKey ?? await readFile(join(moduleDir,'update-public.pem'),'utf8'); }
  async function status(value) {
    await mkdir(updates,{recursive:true});
    await atomicJson(join(updates,'status.json'),{...value,at:now()});
  }
  async function receipt(name) {
    const envelope = await readJson(join(updates,name+'.json'));
    if (!envelope) return null;
    const release = verifyRelease(envelope,await key());
    const directory = join(updates,'releases','v'+release.version);
    await verifyPackage(directory,release);
    return {root:directory,envelope,release};
  }
  return {
    async check(signal) {
      if (busy) return;
      busy = true; let archive, staging;
      try {
        const current = JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
        const response = await fetchImpl(UPDATE_FEED,{redirect:'error',signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(15000)])});
        const envelope = JSON.parse(await boundedResponse(response,16384));
        const release = verifyRelease(envelope,await key());
        if (compareVersions(release.version,current.version) <= 0) {
          await status({state:'current',version:current.version,message:'已是最新版本 '+current.version}); return;
        }
        const rejected = await readJson(join(updates,'rejected.json'));
        if (rejected?.version === release.version) {
          await status({state:'failed',version:current.version,message:'上次更新未能启动，已保留原版本，等待修复版本'}); return;
        }
        const pending = await receipt('pending').catch(()=>null);
        if (pending && compareVersions(pending.release.version,release.version) >= 0) {
          await status({state:'ready',version:pending.release.version,message:'新版 '+pending.release.version+' 已下载，下次启动自动更新'}); return;
        }
        const active = await receipt('active').catch(()=>null);
        if (active && compareVersions(active.release.version,release.version) >= 0) {
          await status({state:'ready',version:active.release.version,message:'新版 '+active.release.version+' 已下载，下次启动自动更新'}); return;
        }
        await mkdir(join(updates,'releases'),{recursive:true});
        await status({state:'downloading',version:release.version,message:'正在后台下载新版 '+release.version});
        const downloadSignal=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(15*60*1000)]);
        const download = await fetchImpl(release.url,{redirect:'error',signal:downloadSignal});
        if (!download.ok || !download.body) throw Error('Update download failed');
        archive=join(updates,'download-'+randomUUID()+'.zip');
        const file=await open(archive,'wx'); let count=0; const hash=createHash('sha256');
        try {
          for await (const chunk of download.body) {
            count+=chunk.length;if(count>release.bytes)throw Error('Update size mismatch');
            hash.update(chunk);await file.writeFile(chunk);
          }
        } finally { await file.close(); }
        if(count!==release.bytes||hash.digest('hex')!==release.sha256)throw Error('Update checksum mismatch');
        staging=join(updates,'staging-'+randomUUID());
        await extract(archive,staging);
        await verifyPackage(staging,release);
        const destination=join(updates,'releases','v'+release.version);
        try { await rename(staging,destination); }
        catch(error) { await verifyPackage(destination,release).catch(()=>{throw error;}); }
        await atomicJson(join(updates,'pending.json'),envelope);
        await status({state:'ready',version:release.version,message:'新版 '+release.version+' 已下载，下次启动自动更新'});
      } catch {
        if(!signal?.aborted)await status({state:'failed',message:'更新检查未完成，继续使用当前版本，下次自动重试'}).catch(()=>{});
      } finally {
        if(archive)await unlink(archive).catch(()=>{});
        if(staging) {
          const child=relative(updates,resolve(staging));
          if(/^staging-[a-f0-9-]{36}$/.test(child))await rm(resolve(staging),{recursive:true,force:true}).catch(()=>{});
        }
        busy=false;
      }
    },
    async resolve() {
      const current=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
      for(const name of ['pending','active','previous']) {
        try {
          const candidate=await receipt(name);
          const rejected=await readJson(join(updates,'rejected.json'));
          if(candidate&&candidate.release.version!==rejected?.version&&compareVersions(candidate.release.version,current.version)>0)return candidate.root;
        } catch { /* A partial or damaged update never prevents portable startup. */ }
      }
      return root;
    },
    async healthy() {
      const pending=await receipt('pending').catch(()=>null);
      if(pending&&resolve(pending.root)===resolve(root)) {
        const active=await readJson(join(updates,'active.json'));
        if(active)await atomicJson(join(updates,'previous.json'),active);
        await atomicJson(join(updates,'active.json'),pending.envelope);
        await unlink(join(updates,'pending.json')).catch(()=>{});
        await status({state:'current',version:pending.release.version,message:'已更新到 '+pending.release.version});
      }
    },
    async reject() {
      const current=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
      await mkdir(updates,{recursive:true});
      await atomicJson(join(updates,'rejected.json'),{version:current.version,at:now()});
      await status({state:'failed',message:'新版启动失败，已回退到原版本'});
    },
  };
}

if(resolve(process.argv[1]??'')===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),value=name=>args[args.indexOf(name)+1];
  if(!args.includes('--root')||!args.includes('--state')||!isAbsolute(value('--root'))||!isAbsolute(value('--state')))throw Error('Absolute update paths required');
  const updater=createUpdater({root:value('--root'),stateDir:value('--state')});
  if(args.includes('--resolve'))console.log(JSON.stringify({root:await updater.resolve()}).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')));
  else if(args.includes('--reject'))await updater.reject();
}
