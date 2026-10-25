import {readFile,writeFile,rename,mkdir,lstat,open}from'node:fs/promises';import{isAbsolute,extname,basename,join}from'node:path';import{randomUUID}from'node:crypto';
import{cleanGameData}from'../dsh-coach-server/lib/game-memory.js';
// User-selected local log only. Agent tools cannot choose paths or open files.
export async function createExternalLogSource({stateDir,publish,now=Date.now}){
 const file=join(stateDir,'external-log-source.json');let source=null,offset=0,pending=Buffer.alloc(0),match='',busy=false,closed=false,revision=0,birth=0,generation=0,genericEmitted=false;
 let writes=Promise.resolve();
 const persist=value=>{const task=writes.catch(()=>{}).then(async()=>{await writeFile(file+'.tmp',JSON.stringify(value),{mode:0o600});await rename(file+'.tmp',file);});writes=task;return task;};
 const save=()=>persist({path:source,offset:offset-pending.length,match,birth,savedAt:now()});
 const valid=path=>typeof path==='string'&&isAbsolute(path)&&!/^[/\\]{2}/.test(path)&&['.log','.jsonl','.ndjson'].includes(extname(path).toLowerCase());
 async function select(path,persist=true){
  if(!valid(path))throw Object.assign(Error('Choose a local game log file'),{status:400});const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())throw Object.assign(Error('Regular log file required'),{status:400});
  generation++;source=path;birth=info.birthtimeMs;offset=Math.max(0,info.size-65536);pending=Buffer.alloc(0);match='external-'+randomUUID();revision=0;genericEmitted=false;
  if(offset){const handle=await open(path,'r');try{const buffer=Buffer.alloc(Math.min(65536,info.size-offset));const read=await handle.read(buffer,0,buffer.length,offset),end=buffer.subarray(0,read.bytesRead).indexOf(10);offset=end>=0?offset+end+1:info.size;}finally{await handle.close();}}
  if(persist)await save();
 }
 await mkdir(stateDir,{recursive:true});try{const saved=JSON.parse(await readFile(file,'utf8'));await select(saved.path,false);if(saved.birth===birth&&Number.isSafeInteger(saved.offset)&&saved.offset>=0&&saved.offset<=(await lstat(source)).size&&/^external-[a-f0-9-]{36}$/.test(saved.match)&&now()-saved.savedAt<1800000){offset=saved.offset;match=saved.match;}}catch{}
 const redact=value=>String(cleanGameData(value)).replace(/\b(?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*["']?[^,\s"']+/gi,'[凭据已隐藏]');
 return{status:()=>({enabled:!!source,fileName:source?basename(source):null}),async start({path}){await select(path);return this.status();},async stop(){source=null;generation++;if(genericEmitted)await publish({game:'generic',match,t:now(),kind:'phase',phase:'CapturePaused'});genericEmitted=false;await persist({});return this.status();},
  async tick(){if(closed||busy||!source)return;busy=true;const owner=source,expected=generation;
   try{
    const info=await lstat(owner);if(!info.isFile()||info.isSymbolicLink())return;if(info.size<offset||info.birthtimeMs!==birth){birth=info.birthtimeMs;offset=0;pending=Buffer.alloc(0);match='external-'+randomUUID();revision=0;}
    if(info.size===offset&&!pending.includes(10))return;let chunk=Buffer.alloc(0);if(!pending.includes(10)){const handle=await open(owner,'r');try{const buffer=Buffer.alloc(Math.min(65536,info.size-offset));const read=await handle.read(buffer,0,buffer.length,offset);chunk=buffer.subarray(0,read.bytesRead);offset+=read.bytesRead;}finally{await handle.close();}}
    if(source!==owner||generation!==expected||closed)return;pending=Buffer.concat([pending,chunk]);let end=-1;for(let i=0;i<100;i++){const next=pending.indexOf(10,end+1);if(next<0)break;end=next;}if(end<0){if(pending.length>65536)pending=Buffer.alloc(0);return;}
    const lines=pending.subarray(0,end).toString('utf8').split('\n');pending=pending.subarray(end+1);const at=Math.floor(Math.min(now(),info.mtimeMs));let generic=false,last='';
    for(const line of lines.filter(Boolean)){
     if(generation!==expected||closed)return;
     let value;try{value=JSON.parse(line);}catch{}
     if(value&&typeof value==='object'&&!Array.isArray(value)&&['lol','wzry'].includes(value.game)){await publish({...cleanGameData(value),t:value.t??at,match:value.match??match});continue;}
     generic=true;const clean=redact(line);last=clean.slice(0,2000);await publish({game:'generic',match,t:at,kind:'external_log',text:last,...(clean.length>2000?{truncated:true}:{})});
    }
    if(generic&&generation===expected){genericEmitted=true;revision++;await publish({game:'generic',match,t:now(),kind:'state',state:{genericState:{sourceKind:'log',sourceUpdatedAt:at,identity:'unconfirmed',windowTitle:'游戏日志流',observationRevision:revision,lastLog:last.slice(0,600)}}});}
    if(source===owner&&generation===expected)await save();
   }catch{}finally{busy=false;}
  },async close(){closed=true;source=null;generation++;await writes;}};
}
