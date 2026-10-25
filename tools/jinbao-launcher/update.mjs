import { createHash, randomUUID, verify } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, open, unlink, readdir, lstat, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const UPDATE_FEED = 'https://api.jinbaoai.top/downloads/dsh/latest.json';
export const STANDALONE_FEED = 'https://api.jinbaoai.top/downloads/jinbao/latest.json';
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

export function verifyRelease(envelope, publicKey, channel='legacy') {
  if(!['legacy','standalone'].includes(channel))throw Error('Invalid update channel');
  if (!envelope || typeof envelope.payload !== 'string' || envelope.payload.length > 12000 || typeof envelope.signature !== 'string') throw Error('Invalid release envelope');
  const payload = Buffer.from(envelope.payload, 'base64');
  const signature = Buffer.from(envelope.signature, 'base64');
  if (payload.toString('base64') !== envelope.payload || signature.length !== 64 || !verify(null, payload, publicKey, signature)) throw Error('Invalid release signature');
  const release = JSON.parse(payload);
  compareVersions(release.version, release.version);
  const directory=channel==='standalone'?'jinbao':'dsh';
  if ((channel==='standalone'?release.runtime!=='standalone':release.runtime!==undefined&&release.runtime!=='legacy')||release.url !== `https://api.jinbaoai.top/downloads/${directory}/v${release.version}/jinbao-desktop-windows.zip` ||
      !Number.isSafeInteger(release.bytes) || release.bytes <= 0 || release.bytes > MAX_ARCHIVE ||
      !/^[a-f0-9]{64}$/.test(release.sha256) || !/^[a-f0-9]{64}$/.test(release.manifestSha256)) throw Error('Invalid release metadata');
  if(release.notes!==undefined&&(typeof release.notes!=='string'||release.notes.length>4000))throw Error('Invalid release notes');
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
  if(release.runtime==='standalone'&&manifest.runtime!=='standalone')throw Error('Wrong package runtime');
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
  const requiredFiles=release.runtime==='standalone'?['runtime/node.exe','start-preview.vbs','tools/cloud-desktop/entry.mjs','tools/cloud-desktop/main.mjs','tools/jinbao-launcher/update.mjs']:['runtime/node.exe','start-jinbao.vbs','tools/jinbao-launcher/start.ps1','tools/jinbao-launcher/main.mjs','tools/jinbao-launcher/update.mjs'];
  for (const required of requiredFiles) {
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

export function createUpdater({ root, stateDir, fetchImpl = fetch, publicKey, extract = extractArchive, now = Date.now, channel='legacy' }) {
  if(!['legacy','standalone'].includes(channel))throw Error('Invalid update channel');
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
    const release = verifyRelease(envelope,await key(),channel);
    const directory = join(updates,'releases','v'+release.version);
    await verifyPackage(directory,release);
    return {root:directory,envelope,release};
  }
  return {
    async check(signal) {
      if (busy) return;
      busy = true; let archive, staging,phase='checking',currentVersion,targetVersion;
      try {
        const current = JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
        currentVersion=current.version;
        await status({state:'checking',version:current.version,currentVersion,message:'正在检查更新…'});
        const response = await fetchImpl(channel==='standalone'?STANDALONE_FEED:UPDATE_FEED,{redirect:'error',signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(15000)])});
        const envelope = JSON.parse(await boundedResponse(response,16384));
        const release = verifyRelease(envelope,await key(),channel);
        targetVersion=release.version;
        if (compareVersions(release.version,current.version) <= 0) {
          await status({state:'current',version:current.version,currentVersion,notes:release.notes,message:'已是最新版本 '+current.version}); return;
        }
        const rejected = await readJson(join(updates,'rejected.json'));
        if (rejected?.version === release.version) {
          await status({state:'failed',version:current.version,message:'上次更新未能启动，已保留原版本，等待修复版本'}); return;
        }
        const pending = await receipt('pending').catch(()=>null);
        if (pending && compareVersions(pending.release.version,release.version) >= 0) {
          await status({state:'ready',version:pending.release.version,currentVersion,notes:pending.release.notes,message:'新版 '+pending.release.version+' 已就绪，可在方便时安装'}); return;
        }
        const active = await receipt('active').catch(()=>null);
        if (active && compareVersions(active.release.version,release.version) >= 0) {
          await status({state:'ready',version:active.release.version,currentVersion,notes:active.release.notes,message:'新版 '+active.release.version+' 已就绪，可在方便时安装'}); return;
        }
        await mkdir(join(updates,'releases'),{recursive:true});
        phase='downloading';
        await status({state:'downloading',version:release.version,currentVersion,downloadedBytes:0,totalBytes:release.bytes,percent:0,notes:release.notes,message:'正在后台下载新版 '+release.version});
        const downloadSignal=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(15*60*1000)]);
        const download = await fetchImpl(release.url,{redirect:'error',signal:downloadSignal});
        if (!download.ok || !download.body) throw Error('Update download failed');
        archive=join(updates,'download-'+randomUUID()+'.zip');
        const file=await open(archive,'wx'); let count=0,lastProgress=0; const started=now();const hash=createHash('sha256');
        try {
          for await (const chunk of download.body) {
            count+=chunk.length;if(count>release.bytes)throw Error('Update size mismatch');
            hash.update(chunk);await file.writeFile(chunk);
            if(now()-lastProgress>=500||count===release.bytes){lastProgress=now();await status({state:'downloading',version:release.version,currentVersion,notes:release.notes,downloadedBytes:count,totalBytes:release.bytes,percent:Math.floor(count/release.bytes*100),bytesPerSecond:Math.round(count/Math.max(.001,(now()-started)/1000)),message:'正在后台下载新版 '+release.version+' · '+Math.floor(count/release.bytes*100)+'%'});}
          }
        } finally { await file.close(); }
        phase='verifying';
        await status({state:'verifying',version:release.version,currentVersion,notes:release.notes,message:'下载完成，正在验证更新完整性…'});
        if(count!==release.bytes||hash.digest('hex')!==release.sha256)throw Error('Update checksum mismatch');
        staging=join(updates,'staging-'+randomUUID());
        phase='extracting';
        await status({state:'extracting',version:release.version,currentVersion,notes:release.notes,message:'验证通过，正在准备安装文件…'});
        await extract(archive,staging);
        await verifyPackage(staging,release);
        const destination=join(updates,'releases','v'+release.version);
        try { await rename(staging,destination); }
        catch(error) { await verifyPackage(destination,release).catch(()=>{throw error;}); }
        await atomicJson(join(updates,'pending.json'),envelope);
        await atomicJson(join(updates,'ready-context.json'),{version:release.version,fromVersion:current.version,notes:release.notes});
        await status({state:'ready',version:release.version,currentVersion,notes:release.notes,message:'新版 '+release.version+' 已就绪，可在方便时安装'});
      } catch {
        if(!signal?.aborted){
          const prepared=await receipt('pending').catch(()=>null);
          const usable=prepared&&currentVersion&&compareVersions(prepared.release.version,currentVersion)>0;
          await status(usable?{state:'ready',version:prepared.release.version,currentVersion,notes:prepared.release.notes,message:'本次检查未完成；已下载的新版仍可安装'}:{state:'failed',currentVersion,version:targetVersion,failedPhase:phase,retryable:true,message:{checking:'暂时无法检查更新，当前版本可继续使用。请检查网络后重试。',downloading:'下载未完成，当前版本可继续使用，点击重试重新下载。',verifying:'更新文件验证失败，已丢弃下载，当前版本未受影响。',extracting:'准备更新文件失败，请检查磁盘空间后重试。'}[phase]}).catch(()=>{});
        }
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
    async prepared(){
      const current=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
      for(const name of ['pending','active']){
        const candidate=await receipt(name).catch(()=>null),rejected=await readJson(join(updates,'rejected.json'));
        if(candidate&&candidate.release.version!==rejected?.version&&compareVersions(candidate.release.version,current.version)>=0)return {root:candidate.root,release:candidate.release};
      }
      return null;
    },
    async healthy() {
      const pending=await receipt('pending').catch(()=>null);
      if(pending&&resolve(pending.root)===resolve(root)) {
        const active=await readJson(join(updates,'active.json'));
        if(active)await atomicJson(join(updates,'previous.json'),active);
        await atomicJson(join(updates,'active.json'),pending.envelope);
        await unlink(join(updates,'pending.json')).catch(()=>{});
        const context=await readJson(join(updates,'ready-context.json'));
        await atomicJson(join(updates,'result.json'),{id:randomUUID(),state:'success',version:pending.release.version,fromVersion:context?.version===pending.release.version?context.fromVersion:null,notes:pending.release.notes,message:'更新成功，已运行 '+pending.release.version,at:now()});
        await atomicJson(join(updates,'apply-status.json'),{state:'complete',version:pending.release.version,message:'更新成功，已运行 '+pending.release.version,at:now()});
        await status({state:'current',version:pending.release.version,notes:pending.release.notes,message:'已更新到 '+pending.release.version});
      }
    },
    async reject() {
      const current=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
      await mkdir(updates,{recursive:true});
      await atomicJson(join(updates,'rejected.json'),{version:current.version,at:now()});
      await status({state:'failed',message:'新版启动失败，已回退到原版本'});
      await atomicJson(join(updates,'result.json'),{id:randomUUID(),state:'rollback',version:current.version,message:'新版 '+current.version+' 启动失败，已自动回退，原有设置保留。',at:now()});
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
