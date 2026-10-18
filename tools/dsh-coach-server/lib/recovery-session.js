import {readFileSync,mkdirSync,writeFileSync,renameSync} from 'node:fs';import {join} from 'node:path';import {createHash} from 'node:crypto';
const file=(root,base)=>join(root,'agent-recovery',createHash('sha256').update(base).digest('hex')+'.json');
export function loadRecoverySession(root,base){try{const v=JSON.parse(readFileSync(file(root,base),'utf8'));return v.base===base&&typeof v.id==='string'&&v.id.startsWith(base+'-recover-')&&/^[a-zA-Z0-9-]+$/.test(v.id)&&v.id.length<200?v.id:base;}catch{return base;}}
export function saveRecoverySession(root,base,id){const path=file(root,base);mkdirSync(join(root,'agent-recovery'),{recursive:true});writeFileSync(path+'.tmp',JSON.stringify({base,id}),{mode:0o600});renameSync(path+'.tmp',path);}
