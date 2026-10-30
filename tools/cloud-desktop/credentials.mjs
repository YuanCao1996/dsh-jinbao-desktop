import{spawn}from'node:child_process';import{readFile,open,mkdir,rename}from'node:fs/promises';import{join,dirname}from'node:path';import{fileURLToPath}from'node:url';
function dpapi(action,value){return new Promise((resolve,reject)=>{
 const script=fileURLToPath(new URL('./protect.ps1',import.meta.url));
 const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-Action',action],{windowsHide:true,cwd:dirname(script),stdio:['pipe','pipe','ignore']});let output='';
 child.stdout.on('data',b=>{output+=b.toString();if(output.length>1000000)child.kill();});child.on('error',()=>reject(Error('Credential protection unavailable')));child.on('close',code=>code===0?resolve(output.trim()):reject(Error('Credential protection failed')));child.stdin.on('error',()=>{});child.stdin.end(value);
});}
export async function createCredentials(stateDir,{crypt=dpapi}={}){
 await mkdir(stateDir,{recursive:true});const path=join(stateDir,'credentials.dpapi');let values={};
 try{values=JSON.parse(await crypt('unprotect',await readFile(path,'utf8')));}catch(error){if(error.code!=='ENOENT')throw Error('Cannot unlock saved credentials');}
 let queue=Promise.resolve();
 const mutate=fn=>{const next=queue.then(async()=>{const updated={...values};fn(updated);const encoded=await crypt('protect',JSON.stringify(updated));const file=await open(path+'.tmp','w',0o600);try{await file.writeFile(encoded);await file.sync();}finally{await file.close();}await rename(path+'.tmp',path);if(process.platform!=='win32'){const parent=await open(stateDir,'r');try{await parent.sync();}finally{await parent.close();}}values=updated;});queue=next.catch(()=>{});return next;};
 return {async resolve(key){await queue;return typeof values[key]==='string'?{value:values[key]}:undefined;},set(key,value){if(typeof key!=='string'||typeof value!=='string'||value.length>16000)throw Error('Invalid credential');return mutate(v=>{v[key]=value;});},unset(key){return mutate(v=>{delete v[key];});}};
}
