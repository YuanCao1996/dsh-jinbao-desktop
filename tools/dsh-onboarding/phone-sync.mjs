import {randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {hostname} from 'node:os';
import {createPhoneChat} from './phone-chat.mjs';

export function phoneSnapshot(view,now=Date.now()){
  const out={};
  for(const key of ['title','summary','gameTime','phase','advice','equipment','augments','players','events','chat','game','match','ended','updatedAt','playerRows'])if(view[key]!==undefined)out[key]=view[key];
  for(const key of ['chat','events'])if(typeof out[key]==='string')out[key]=out[key].slice(-4000);
  out.playerRows=(Array.isArray(view.playerRows)?view.playerRows:[]).slice(0,30).map(row=>({side:row.side,champion:row.champion,winRateText:row.winRateText,tierText:row.tierText}));
  out.chatRows=(Array.isArray(view.chatRows)?view.chatRows:[]).slice(-12).map(row=>({role:row.role,origin:row.origin,text:String(row.text??'').slice(0,4000)}));
  while(Buffer.byteLength(JSON.stringify(out))>90000&&out.chatRows.length)out.chatRows.shift();
  out.matchActive=!!view.match&&!view.ended&&view.gameTime!=='等待对局'&&now-view.updatedAt<30000;
  return out;
}
export async function createPhoneSync({stateDir,view,ask,getToken,serviceBaseUrl,fetchImpl=fetch,pollMs=3000,now=Date.now,allowEmail=false}){
  const validToken=token=>(allowEmail?/^j[cd]_[a-f0-9]{64}$/:/^jd_[a-f0-9]{64}$/).test(token??'');
  const file=join(stateDir,'sync-device.json'),preferences=join(stateDir,'sync-preferences.json');
  let device;
  try{device=JSON.parse(await readFile(file,'utf8'));}catch{}
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(device?.id??'')){
    device={id:randomUUID(),name:hostname().slice(0,80)};await writeFile(file,JSON.stringify(device),{mode:0o600});
  }
  let enabled=true;
  try{enabled=JSON.parse(await readFile(preferences,'utf8')).enabled!==false;}catch{}
  let closed=false,busy=false,lastHash='',lastSent=0,task=Promise.resolve(),nextAttempt=0,lastToken=null;
  let current={linked:false,enabled,deviceName:device.name,state:'unlinked',message:'生成配对码，在手机 App 的“连接电脑”中输入'};
  const endpoint=new URL('/desktop/sync/devices/'+device.id+'/state',serviceBaseUrl);
  async function request(method,token,data){
    const response=await fetchImpl(endpoint,{method,headers:{Authorization:'Bearer '+token,...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{}),redirect:'error',signal:AbortSignal.timeout(10000)});
    await response.body?.cancel();if(!response.ok)throw Object.assign(Error('sync request failed'),{status:response.status});
  }
  async function tick(){
    if(closed||busy||now()<nextAttempt)return;
    busy=true;
    try{
      const token=await getToken();
      if(!validToken(token)){current={...current,linked:false,state:'unlinked',message:'尚未配对：生成配对码，在 App 的“连接电脑”中输入，无需账号一致'};return;}
      if(lastToken!==token){if(lastToken)await request('DELETE',lastToken).catch(()=>{});lastToken=token;lastHash='';lastSent=0;}
      current={...current,linked:true};
      if(!enabled){current={...current,state:'disabled',message:'手机同步已关闭'};return;}
      const snapshot=phoneSnapshot(view(),now()),hash=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
      snapshot.chatCapable=typeof ask==='function';
      if(hash===lastHash&&now()-lastSent<10000)return;
      await request('PUT',token,{deviceName:device.name,snapshot});
      if(closed)return;
      lastHash=hash;lastSent=now();current={...current,state:'connected',lastSyncedAt:lastSent,message:'已配对并同步，可在 App 的“电脑对局”中查看；无需账号一致'};
    }catch(error){
      nextAttempt=now()+([401,403].includes(error.status)?60000:15000);
      current={...current,linked:![401,403].includes(error.status),state:'error',message:[401,403].includes(error.status)?'手机配对已失效，请重新生成配对码':'同步连接失败，正在自动重试'};
    }finally{busy=false;}
  }
  const run=()=>{if(!busy)task=tick();return task;};
  const timer=setInterval(run,pollMs);timer.unref();void run();
  const chat=typeof ask==='function'?await createPhoneChat({stateDir,deviceId:device.id,getToken,view,ask,serviceBaseUrl,fetchImpl,enabled:()=>enabled&&!closed,pollMs,allowEmail}):null;
  return {
    status:()=>({...current,enabled}),tick:run,
    async enable(){enabled=true;await writeFile(preferences,JSON.stringify({enabled:true}),{mode:0o600});nextAttempt=0;lastHash='';return run();},
    async disable(){
      enabled=false;await writeFile(preferences,JSON.stringify({enabled:false}),{mode:0o600});await task.catch(()=>{});
      const token=await getToken();if(validToken(token))await request('DELETE',token).catch(()=>{});
      current={...current,enabled:false,state:'disabled',message:'手机同步已关闭'};
    },
    async close(){closed=true;clearInterval(timer);await task.catch(()=>{});await chat?.close();},
  };
}
