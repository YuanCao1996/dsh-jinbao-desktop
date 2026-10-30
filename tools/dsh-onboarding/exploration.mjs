import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, open, unlink} from 'node:fs/promises';
import {join} from 'node:path';

// Only explicit, verified-account actions reach the network. Pair-only tokens
// and shared IP trial identities are rejected by the backend.
export function createDesktopExploration({stateDir, serviceBaseUrl, getToken, fetchImpl=fetch}) {
  const root=join(stateDir,'exploration');
  let serial=Promise.resolve();
  const lock=fn=>{const next=serial.then(fn);serial=next.catch(()=>{});return next;};
  const fail=(message,status=0)=>Object.assign(new Error(message),{status});
  async function identity(){
    const token=await getToken();
    if(!/^j[dc]_[a-f0-9]{64}$/.test(token??''))throw fail('请先登录已验证的账号',401);
    return token;
  }
  async function request(token,path,data){
    if(await identity()!==token)throw fail('登录账号已变化',409);
    const url=new URL(path,serviceBaseUrl);
    if(url.protocol!=='https:'||url.username||url.password)throw fail('服务器地址不可用');
    const response=await fetchImpl(url,{method:data===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(10000),
      headers:{Authorization:'Bearer '+token,...(data===undefined?{}:{'Content-Type':'application/json'})},
      ...(data===undefined?{}:{body:JSON.stringify(data)})});
    const chunks=[];let size=0;
    if(response.body){for await(const chunk of response.body){size+=chunk.length;if(size>524288){await response.body.cancel?.().catch(()=>{});throw fail('响应过大');}chunks.push(Buffer.from(chunk));}}
    const text=Buffer.concat(chunks).toString('utf8');
    let value;try{value=JSON.parse(text);}catch{throw fail('服务响应异常',response.status);}
    if(await identity()!==token)throw fail('登录账号已变化',409);
    if(!response.ok)throw fail(value.code==='revision_conflict'?'其他设备的数据已变化，需要检查差异':value.code==='not_participating'?'已退出探索榜':'探索服务暂不可用',response.status);
    if(!/^[a-f0-9]{64}$/.test(value.owner_scope??''))throw fail('账号身份无法确认');
    return value;
  }
  async function profile(token){return request(token,'/profile/exploration');}
  function checkScope(game,season,category){
    if(game==='lol_pc'&&season===''&&['英雄','模式'].includes(category))return;
    if(game==='wzry'&&season===''&&['英雄','模式'].includes(category))return;
    if(game==='jinchanchan'&&/^S[0-9]{1,6}(?:\.[0-9]{1,2})?$/.test(season)&&(['阵容','弈子','羁绊'].includes(category)||(category==='模式'&&season==='S18')))return;
    throw fail('该图鉴暂未开放');
  }
  function scopeQuery(game,season,category){checkScope(game,season,category);return new URLSearchParams({game,season,category}).toString();}
  async function read(owner){
    if(!/^[a-f0-9]{64}$/.test(owner))throw fail('账号身份无法确认');
    try{
      const text=await readFile(join(root,owner+'.json'),'utf8');if(Buffer.byteLength(text)>524288)throw fail('本机探索记录过大');
      const value=JSON.parse(text);if(value?.version!==1||!Array.isArray(value.pending)||!value.local||typeof value.local!=='object')throw fail('本机探索记录异常');return value;
    }catch(error){if(error.code==='ENOENT')return {version:1,local:{},pending:[]};throw error;}
  }
  async function save(owner,value){
    const content=JSON.stringify(value);if(Buffer.byteLength(content)>524288)throw fail('本机探索记录过大');
    await mkdir(root,{recursive:true});const filename=join(root,owner+'.json'),tmp=join(root,owner+'.'+randomUUID()+'.tmp');
    let handle;
    try{
      handle=await open(tmp,'wx',0o600);
      await handle.writeFile(content);await handle.sync();await handle.close();handle=null;
      await rename(tmp,filename);
    }finally{
      if(handle)await handle.close().catch(()=>{});
      await unlink(tmp).catch(error=>{if(error.code!=='ENOENT')throw error;});
    }
  }
  function sameOwner(expected,...values){if(values.some(value=>value.owner_scope!==expected))throw fail('账号身份已变化',409);}
  async function view(game,season,category){return lock(async()=>{
    const token=await identity(),query=scopeQuery(game,season,category),initial=await profile(token),owner=initial.owner_scope;
    const catalog=await request(token,'/profile/exploration/catalog?'+query);
    const board=await request(token,'/profile/exploration/leaderboard?'+query);
    sameOwner(owner,catalog,board);
    const local=await read(owner),key=[game,season,category].join('|');
    if(await identity()!==token)throw fail('登录账号已变化',409);
    // Synced local entries are no longer authoritative: another device may
    // have explicitly withdrawn them. Only pending local actions override cloud.
    const selected=new Set(initial.exploration.scopes?.[key]??[]);
    for(const operation of local.pending)if([operation.game,operation.season,operation.category].join('|')===key){
      if(operation.operation==='add')selected.add(operation.entity);else selected.delete(operation.entity);
    }
    return {participating:initial.exploration.participating===true,names:catalog.names,catalogComplete:catalog.complete===true,icons:catalog.icons??{},aliases:catalog.aliases??{},
      local:local.local[key]??[],selected:[...selected],pending:local.pending.length,board:board.board,
      cloud:initial.exploration.scopes?.[key]??[]};
  });}
  async function mark(game,season,category,entity,explored){return lock(async()=>{
    const token=await identity(),query=scopeQuery(game,season,category),initial=await profile(token),owner=initial.owner_scope;
    if(typeof entity!=='string'||typeof explored!=='boolean')throw fail('探索记录无效');
    const catalog=await request(token,'/profile/exploration/catalog?'+query);sameOwner(owner,catalog);
    if(!Array.isArray(catalog.names)||!catalog.names.includes(entity))throw fail('当前图鉴中没有该条目');
    const local=await read(owner),key=[game,season,category].join('|'),values=new Set(local.local[key]??[]);
    if(explored)values.add(entity);else values.delete(entity);local.local[key]=[...values].sort();
    local.pending.push({game,season,category,entity,operation:explored?'add':'remove',operationId:randomUUID().replaceAll('-',''),revision:null});
    if(local.pending.length>5000)throw fail('待同步记录过多，请先同步');
    await save(owner,local);return {saved:true,pending:local.pending.length};
  });}
  async function participation(enabled){return lock(async()=>{
    if(typeof enabled!=='boolean')throw fail('参与状态无效');
    const token=await identity(),initial=await profile(token);
    const result=await request(token,'/profile/exploration/participation',{revision:initial.exploration.revision,participating:enabled});
    sameOwner(initial.owner_scope,result);return {participating:enabled};
  });}
  async function sync(){return lock(async()=>{
    const token=await identity(),initial=await profile(token),owner=initial.owner_scope;
    if(initial.exploration.participating!==true)throw fail('请先参与探索榜');
    const local=await read(owner);let completed=0;
    while(local.pending.length&&completed<100){
      const op=local.pending[0],current=await profile(token);sameOwner(owner,current);
      if(current.exploration.participating!==true)throw fail('已退出探索榜');
      if(op.revision===null){op.revision=current.exploration.revision;await save(owner,local);}
      const payload={revision:op.revision,game:op.game,season:op.season,category:op.category,
        add:op.operation==='add'?[op.entity]:[],remove:op.operation==='remove'?[op.entity]:[],operation_id:op.operationId};
      const response=await request(token,'/profile/exploration/delta',payload);sameOwner(owner,response);
      if(response.revision!==op.revision+1)throw fail('同步结果无法核验');
      local.pending.shift();await save(owner,local);completed++;
    }
    return {completed,pending:local.pending.length};
  });}
  async function conflict(){return lock(async()=>{
    const token=await identity(),current=await profile(token),owner=current.owner_scope,local=await read(owner),op=local.pending[0];
    if(!op||op.revision===null)throw fail('当前没有可检查的冲突');
    const key=[op.game,op.season,op.category].join('|');
    return {operationId:op.operationId,game:op.game,season:op.season,category:op.category,entity:op.entity,
      operation:op.operation,remote:(current.exploration.scopes?.[key]??[]).includes(op.entity),revision:current.exploration.revision};
  });}
  async function resolve(operationId,revision){return lock(async()=>{
    if(!/^[a-f0-9]{32}$/.test(operationId??'')||!Number.isSafeInteger(revision)||revision<0)throw fail('冲突信息无效');
    const token=await identity(),current=await profile(token),owner=current.owner_scope,local=await read(owner),op=local.pending[0];
    if(current.exploration.revision!==revision||!op||op.operationId!==operationId)throw fail('数据再次变化，请重新检查差异',409);
    op.operationId=randomUUID().replaceAll('-','');op.revision=revision;await save(owner,local);return {resolved:true};
  });}
  return {view,mark,participation,sync,conflict,resolve};
}
