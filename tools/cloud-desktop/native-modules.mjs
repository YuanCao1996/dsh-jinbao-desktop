import {open,readFile,mkdir,writeFile,rename,rm,stat,realpath} from 'node:fs/promises';
import {join,resolve,relative,dirname,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
export const NATIVE_PACKAGES=['cordis','dsh-agent','dsh-agent-loop','dsh-llm','dsh-session','dsh-session-projection','dsh-system-prompt','dsh-tools','dsh-token-meter','dsh-compaction-basic','dsh-session-persistence-jsonl'].map(n=>'@deepseek-ai/'+n);
const safe=name=>typeof name==='string'&&name.length>0&&!name.includes('\\')&&!name.includes(':')&&name.split('/').every(p=>p&&p!=='.'&&p!=='..');
const hash=b=>createHash('sha256').update(b).digest('hex');
const escaped=(root,path)=>{const local=relative(root,path);return local.startsWith('..')||isAbsolute(local);};
// Only extract native Agent dependencies from the user's installed DSH archive.
// Never load Electron UI, arbitrary profile plugins, or another user's credentials.
export async function extractNativeModules(archive,destination){
 const file=await open(archive,'r');let staging;
 try{
  const header=Buffer.alloc(16);await file.read(header,0,16,0);
  const bytes=header.readUInt32LE(12),offset=8+header.readUInt32LE(4);
  if(bytes<2||bytes>64*1024*1024||offset<16+bytes)throw Error('Invalid DSH archive');
  const encoded=Buffer.alloc(bytes);await file.read(encoded,0,bytes,16);
  const tree=JSON.parse(encoded).files?.dsh?.files?.node_modules?.files;
  if(!tree)throw Error('DSH native modules missing');
  const entries=new Map(),packages=new Set();let total=0;
  const node=name=>name.split('/').reduce((value,part)=>value?.files?.[part],{files:tree});
  async function contents(name,entry){
   if(!safe(name)||entry.link||!Number.isSafeInteger(entry.size)||entry.size<0||entry.size>32*1024*1024)throw Error('Unsafe DSH archive entry');
   let data;
   if(entry.unpacked){const root=await realpath(archive+'.unpacked'),source=await realpath(join(root,'dsh','node_modules',name));if(escaped(root,source))throw Error('DSH module escaped archive');data=await readFile(source);}
   else{const at=Number(entry.offset);if(!Number.isSafeInteger(at)||at<0)throw Error('Invalid DSH archive offset');data=Buffer.alloc(entry.size);const result=await file.read(data,0,data.length,offset+at);if(result.bytesRead!==data.length)throw Error('Incomplete DSH module');}
   if(data.length!==entry.size||entry.integrity&&(entry.integrity.algorithm!=='SHA256'||hash(data)!==entry.integrity.hash))throw Error('DSH module integrity mismatch');
   return data;
  }
  function collect(prefix,entry){for(const [part,value]of Object.entries(entry.files??{})){const name=prefix+'/'+part;if(!safe(name)||value.link)throw Error('Unsafe DSH module path');if(value.files)collect(name,value);else{total+=value.size??0;if(entries.size>=5000||total>100*1024*1024)throw Error('DSH dependencies too large');entries.set(name,value);}}}
  async function visit(name){
   if(packages.has(name))return;const entry=node(name);if(!entry?.files?.['package.json'])throw Error('DSH dependency missing: '+name);
   packages.add(name);const manifest=JSON.parse(await contents(name+'/package.json',entry.files['package.json']));collect(name,entry);
   for(const dependency of Object.keys({...manifest.dependencies,...manifest.peerDependencies,...manifest.optionalDependencies})){
    if(node(dependency)?.files?.['package.json'])await visit(dependency);
    else if(!manifest.peerDependenciesMeta?.[dependency]?.optional&&!manifest.optionalDependencies?.[dependency])throw Error('DSH dependency missing: '+dependency);
   }
  }
  for(const name of NATIVE_PACKAGES)await visit(name);
  staging=destination+'.staging-'+randomUUID();await mkdir(join(staging,'node_modules'),{recursive:true});
  const inventory=[];
  for(const [name,entry]of entries){const target=join(staging,'node_modules',name),data=await contents(name,entry);await mkdir(dirname(target),{recursive:true});await writeFile(target,data);inventory.push({path:name,bytes:data.length,sha256:hash(data)});}
  await writeFile(join(staging,'native-source.json'),JSON.stringify({archive:resolve(archive),headerHash:hash(encoded),packages:packages.size,files:entries.size,entries:inventory}));
  await rename(staging,destination);staging=null;return destination;
 }finally{await file.close();if(staging)await rm(staging,{recursive:true,force:true});}
}
export async function locateNativeModules({stateDir,desktopPath,moduleRoot}={}){
 if(moduleRoot){const root=resolve(moduleRoot);for(const name of NATIVE_PACKAGES)await stat(join(root,name,'package.json'));return root;}
 if(!desktopPath)try{desktopPath=(await readFile(join(homedir(),'.dsh','jinbao','desktop-path.txt'),'utf8')).trim();}catch{}
 desktopPath??=join(process.env.LOCALAPPDATA??join(homedir(),'AppData/Local'),'Programs/DeepSeek Harness/DeepSeek Harness.exe');
 if(!resolve(desktopPath).toLowerCase().endsWith('deepseek harness.exe'))throw Error('请安装 DSH Desktop，或在设置中填写其程序路径');
 const archive=join(dirname(desktopPath),'resources/app.asar'),info=await stat(archive).catch(()=>{throw Error('未找到 DSH Desktop，请检查安装路径');});
 const cache=join(stateDir,'native-runtime',hash(Buffer.from(JSON.stringify([3,resolve(archive),info.size,info.mtimeMs,NATIVE_PACKAGES]))));
 try{
  const marker=await readFile(join(cache,'native-source.json'),'utf8');if(marker.length>1024*1024)throw Error('Invalid native cache');
  const inventory=JSON.parse(marker).entries;if(!Array.isArray(inventory)||inventory.length<1||inventory.length>5000)throw Error('Invalid native cache');
  for(const entry of inventory){if(!safe(entry.path)||!Number.isSafeInteger(entry.bytes)||entry.bytes<0||entry.bytes>32*1024*1024||!/^[a-f0-9]{64}$/.test(entry.sha256))throw Error('Unsafe native cache');const path=join(cache,'node_modules',entry.path),actual=await realpath(path);if(escaped(cache,actual)||(await stat(actual)).size!==entry.bytes)throw Error('Native cache escaped or damaged');const data=await readFile(actual);if(hash(data)!==entry.sha256)throw Error('Damaged native cache');}
 }catch{
  await mkdir(dirname(cache),{recursive:true});
  // Preserve a damaged cache for diagnosis; never delete a user's DSH install.
  try{await rename(cache,cache+'.invalid-'+randomUUID());}catch(error){if(error.code!=='ENOENT')throw error;}
  await extractNativeModules(archive,cache);
 }
 return join(cache,'node_modules');
}
export function nativeImporter(moduleRoot){const require=createRequire(join(moduleRoot,'..','native-loader.cjs'));return name=>{if(!/^@deepseek-ai\/[a-z0-9-]+$/.test(name))throw Error('Native dependency escaped DSH runtime');const path=require.resolve(name);if(escaped(resolve(moduleRoot),path))throw Error('Native dependency escaped DSH runtime');return import(pathToFileURL(path).href);};}
