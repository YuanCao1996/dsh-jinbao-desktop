import http from 'node:http';
import { randomBytes,timingSafeEqual } from 'node:crypto';
import { mkdir,readFile,writeFile,rename,readdir,stat,open,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { once } from 'node:events';
import { serviceUrl,chatUrl,limitedJson } from '../dsh-game-services/client.mjs';
import { createOverlayService } from './overlay-state.mjs';
import { createPhoneSync } from './phone-sync.mjs';
const refs={local:'JINBAO_LOCAL_ACCESS_KEY',cloud:'JINBAO_SERVICE_TOKEN',byok:'JINBAO_USER_MODEL_API_KEY',sync:'JINBAO_SYNC_TOKEN'};
const same=(a,b)=>typeof a==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const send=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
const error=status=>Object.assign(Error('setup operation failed'),{status});
async function body(req,max=512*1024,onBytes){const declared=Number(req.headers['content-length']);if(Number.isFinite(declared)&&declared>max){onBytes?.(declared);req.resume();throw error(413);}let size=0;const chunks=[];for await(const c of req){size+=c.length;onBytes?.(size);if(size>max)throw error(413);chunks.push(c);}try{const b=JSON.parse(Buffer.concat(chunks));if(!b||typeof b!=='object'||Array.isArray(b))throw 0;return b;}catch{throw error(400);}}
export async function createSetupServer({credentials,stateDir,port=3084,coachPort=3081,serviceBaseUrl='https://api.jinbaoai.top',fetchImpl=fetch}) {
 if(!Number.isInteger(coachPort)||coachPort<1||coachPort>65535)throw Error('Invalid coach port');
 const coachOrigin='http://127.0.0.1:'+coachPort;
 const service=serviceUrl(serviceBaseUrl),nonce=randomBytes(32).toString('hex');
 await mkdir(join(stateDir,'logs'),{recursive:true});
 const filename=join(stateDir,'settings.json');
 let config={mode:'cloud',baseUrl:'',model:''};
 try{config={...config,...JSON.parse(await readFile(filename,'utf8'))};}catch(e){if(e.code!=='ENOENT')throw Error('Invalid Jinbao settings file');}
 let local=(await credentials.resolve(refs.local))?.value;
 if(!local){local=randomBytes(32).toString('hex');await credentials.set(refs.local,local);}
 let pairing=null,mutation=Promise.resolve();
 let wechat={enabled:false,checkedAt:0};
 let nextRenewAttempt=0;
 let nextSyncRenewAttempt=0;
 const locked=fn=>{const next=mutation.then(fn);mutation=next.catch(()=>{});return next;};
 const resolve=async key=>(await credentials.resolve(refs[key]))?.value;
 async function saveConfig(next){await writeFile(filename+'.tmp',JSON.stringify(next),{mode:0o600});await rename(filename+'.tmp',filename);config=next;}
 async function acceptCloud(result){
  if(typeof result.sessionToken!=='string'||!/^j[cdw]_[a-f0-9]{64}$/.test(result.sessionToken))throw error(502);
  const previous=await resolve('cloud');
  await credentials.set(refs.cloud,result.sessionToken);
  if(previous&&previous===await resolve('sync')&&result.sessionToken.startsWith('jd_'))await acceptSync(result);
  nextRenewAttempt=0;
  if(Number.isFinite(result.expiresIn)&&result.expiresIn>0&&result.expiresIn<=2592000){
   await writeFile(join(stateDir,'cloud-login.json'),JSON.stringify({expiresAt:Date.now()+result.expiresIn*1000,renewAfter:Date.now()+86400000}));
  }else await rm(join(stateDir,'cloud-login.json'),{force:true});
  // A deliberate BYOK choice survives account linking. New installations default to cloud.
  if(config.mode!=='byok')await saveConfig({mode:'cloud',baseUrl:'',model:''});
  pairing=null;
 }
 async function acceptSync(result){
  if(typeof result.sessionToken!=='string'||!/^jd_[a-f0-9]{64}$/.test(result.sessionToken))throw error(502);
  await credentials.set(refs.sync,result.sessionToken);nextSyncRenewAttempt=0;
  if(Number.isFinite(result.expiresIn)&&result.expiresIn>0&&result.expiresIn<=2592000){
   await writeFile(join(stateDir,'sync-login.json'),JSON.stringify({expiresAt:Date.now()+result.expiresIn*1000,renewAfter:Date.now()+86400000}));
  }else await rm(join(stateDir,'sync-login.json'),{force:true});
 }
 async function acceptLinkedLogin(result){
  const current=await resolve('cloud');
  await acceptSync(result);
  // Existing trial/activation billing stays independent of WeChat device association.
  if(!current?.startsWith('jc_'))await acceptCloud(result);
  pairing=null;void phoneSync.enable().catch(()=>{});
 }
 async function syncToken(){
  let token=await resolve('sync')??await resolve('cloud');
  if(!token?.startsWith('jd_'))return null;
  try{
   const path=join(stateDir,await resolve('sync')?'sync-login.json':'cloud-login.json');
   const lifetime=JSON.parse(await readFile(path,'utf8'));
   if(Date.now()>lifetime.renewAfter&&Date.now()<lifetime.expiresAt&&Date.now()>=nextSyncRenewAttempt){
    await locked(async()=>{
     const current=await resolve('sync')??await resolve('cloud');
     if(current!==token||Date.now()<nextSyncRenewAttempt)return;
     nextSyncRenewAttempt=Date.now()+300000;
     const result=await remote('/desktop/auth/session/renew',current,{});
     if(current===await resolve('cloud'))await acceptCloud(result);
     await acceptSync(result);
    });token=await resolve('sync')??await resolve('cloud');
   }
  }catch{}
  return token;
 }
 async function remote(path,token,data){
  const response=await fetchImpl(new URL(path,service),{method:data===undefined?'GET':'POST',headers:{...(token?{Authorization:'Bearer '+token}:{}),...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)}),redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!response.ok){await response.body?.cancel();throw error(response.status);}
  return limitedJson(response,16384);
 }
 async function diagnostic(){
  const files=(await readdir(join(stateDir,'logs'))).filter(n=>n.endsWith('.jsonl')&&!n.startsWith('coach_'));
  let recent=null;
  for(const name of files){const info=await stat(join(stateDir,'logs',name));if(!recent||info.mtimeMs>recent.modifiedAt)recent={name,modifiedAt:info.mtimeMs,bytes:info.size};}
  let validTail=false;
  if(recent&&recent.bytes){const f=await open(join(stateDir,'logs',recent.name),'r');try{const n=Math.min(recent.bytes,65536),buffer=Buffer.alloc(n);await f.read(buffer,0,n,recent.bytes-n);const lines=buffer.toString('utf8').trim().split('\n');if(recent.bytes>n)lines.shift();validTail=lines.slice(-10).every(line=>{try{return !!JSON.parse(line);}catch{return false;}});}finally{await f.close();}}
  let coachReady=false;try{const r=await fetchImpl(coachOrigin+'/coach/state',{signal:AbortSignal.timeout(2000),redirect:'error'});if(r.ok)coachReady=(await limitedJson(r,1024*1024)).monitor?.ready===true;else await r.body?.cancel();}catch{}
  const snapshot=overlay.view();
  return {logsDir:join(stateDir,'logs'),logCount:files.length,recent,validTail,coachReady,
   activeGame:snapshot.game,activeMatch:snapshot.match,matchActive:!!snapshot.match&&snapshot.gameTime!=='等待对局'&&!snapshot.ended&&Date.now()-snapshot.updatedAt<30000};
 }
 const overlay=await createOverlayService({stateDir,
  agentChat:async request=>{
   if(config.mode==='demo')throw error(409);
   let response;
   try { response=await fetchImpl(coachOrigin+'/coach/chat',{method:'POST',headers:{Authorization:'Bearer '+local,'Content-Type':'application/json'},body:JSON.stringify(request),redirect:'error',signal:AbortSignal.timeout(300000)}); }
   catch { throw error(503); }
   if(!response.ok){await response.body?.cancel();throw error(response.status);}
   const result=await limitedJson(response,64*1024);
   if(typeof result.answer!=='string'||!result.answer.trim())throw error(502);
   return result.answer;
  },
  search:async query=>{const token=await resolve('cloud');if(!token)throw error(401);return remote('/site/search',token,query);},
 });
 const phoneSync=await createPhoneSync({stateDir,view:overlay.view,ask:overlay.ask,getToken:syncToken,serviceBaseUrl:service,fetchImpl});
 const server=http.createServer(async(req,res)=>{
  const expectedHost='127.0.0.1:'+server.address().port;
  if(req.headers.host!==expectedHost){send(res,403,{error:'invalid_host'});return;}
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  try{
   if(req.url==='/v1/chat/completions'&&req.method==='POST'){
    if(!same(req.headers.authorization,'Bearer '+local))throw error(401);
    const diagnostic={at:Date.now(),bytes:0};
    res.once('finish',()=>{void writeFile(join(stateDir,'model-proxy-diagnostics.json'),JSON.stringify({...diagnostic,status:res.statusCode})).catch(()=>{});});
    const b=await body(req,1024*1024,size=>diagnostic.bytes=size);if(!Array.isArray(b.messages))throw error(400);
    const textOnly={...b,messages:b.messages.map(m=>({...m,content:Array.isArray(m.content)?m.content.map(p=>p?.type==='image_url'?{type:'image_url',image_url:{url:'[inline image]'}}:p):m.content}))};
    if(Buffer.byteLength(JSON.stringify(textOnly))>512*1024)throw error(413);
    diagnostic.messageCount=b.messages.length;diagnostic.toolCount=Array.isArray(b.tools)?b.tools.length:0;diagnostic.systemBytes=Buffer.byteLength(JSON.stringify(b.messages.filter(m=>m.role==='system')));
    if(config.mode==='demo')throw error(409);
    const token=await resolve(config.mode==='byok'?'byok':'cloud');if(!token)throw error(401);
    const endpoint=config.mode==='byok'?chatUrl(config.baseUrl):new URL('/v1/chat/completions',service);
    if(config.mode==='byok'&&endpoint.origin===service.origin)throw error(400);
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),60000);
    res.on('close',()=>controller.abort());
    try{
     const upstream=await fetchImpl(endpoint,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({...b,model:config.mode==='byok'?config.model:'game-fast',max_tokens:Math.min(Number.isInteger(b.max_tokens)?b.max_tokens:2048,2048)}),redirect:'error',signal:controller.signal});
     if(!upstream.ok){await upstream.body?.cancel();throw error(upstream.status);}
     res.writeHead(200,{'Content-Type':b.stream?'text/event-stream':'application/json','Cache-Control':'no-store'});
     let bytes=0;for await(const chunk of upstream.body){bytes+=chunk.length;if(bytes>2*1024*1024)throw error(502);if(!res.write(chunk))await once(res,'drain',{signal:controller.signal});}res.end();
    }finally{clearTimeout(timer);}
    return;
   }
   if(req.method==='GET'&&req.url==='/'){
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"});
    res.end(await readFile(new URL('./settings.html',import.meta.url)));return;
   }
   if(!same(req.headers['x-jinbao-setup'],nonce))throw error(403);
   if(req.headers.origin&&req.headers.origin!=='http://'+expectedHost)throw error(403);
   if(req.url==='/api/overlay'&&req.method==='GET'){send(res,200,overlay.view());return;}
   if(req.url==='/api/overlay/confirm'&&req.method==='POST'){send(res,200,await overlay.confirm(await body(req,4096)));return;}
   if(['/api/overlay/ask','/api/overlay/refresh'].includes(req.url)&&req.method==='POST'){
    if(!String(req.headers['content-type']).startsWith('application/json'))throw error(400);
    const b=await body(req,8192);
    const result=req.url.endsWith('/ask')?await overlay.ask(b.question,b.topic):await overlay.refresh();
    send(res,200,result??{refreshed:true});return;
   }
   if(req.url==='/api/advice'&&req.method==='GET'){
    let snapshot={};try{const state=join(stateDir,'coach_live_state.json');if((await stat(state)).size<=1024*1024)snapshot=JSON.parse(await readFile(state,'utf8'));}catch{}
    const reply=snapshot.lastReply;
    send(res,200,{text:typeof reply?.text==='string'?reply.text.slice(0,2000):'',updatedAt:Number.isFinite(reply?.at)?reply.at:null,game:typeof snapshot.game==='string'?snapshot.game.slice(0,32):null});return;
   }
   if(req.url==='/api/status'&&req.method==='GET'){
    if(Date.now()-wechat.checkedAt>60000){try{const capability=await remote('/desktop/auth/wechat/capabilities');wechat={enabled:capability.enabled===true,checkedAt:Date.now()};}catch{wechat={enabled:false,checkedAt:Date.now()};}}
    let token=await resolve('cloud');let account=null,accountError=null;
    if(token?.startsWith('jd_'))try{
     const lifetime=JSON.parse(await readFile(join(stateDir,'cloud-login.json'),'utf8'));
     if(Date.now()>lifetime.renewAfter&&Date.now()<lifetime.expiresAt&&Date.now()>=nextRenewAttempt){
      await locked(async()=>{
       const current=await resolve('cloud');
       if(current!==token||Date.now()<nextRenewAttempt)return;
       // Apply backoff before calling upstream so concurrent status polls share it.
       nextRenewAttempt=Date.now()+300000;
       await acceptCloud(await remote('/desktop/auth/session/renew',current,{}));
      });
      token=await resolve('cloud');
     }
    }catch{ /* A failed renewal does not invalidate an otherwise valid session. */ }
    if(token)try{account=await remote('/desktop/account',token);}catch(e){accountError=e.status??503;}
    let update=null;
    try{const path=join(stateDir,'updates/status.json');if((await stat(path)).size<8192){const saved=JSON.parse(await readFile(path,'utf8'));update={state:saved.state,version:saved.version,message:saved.message,at:saved.at};}}catch{}
    let phoneCaptureEnabled=false;try{phoneCaptureEnabled=JSON.parse(await readFile(join(stateDir,'phone-capture.json'),'utf8')).enabled===true;}catch{}
    let pluginUpdatePending=false;let version=null;try{const launcher=JSON.parse(await readFile(join(stateDir,'launcher-state.json'),'utf8'));version=launcher.version??null;pluginUpdatePending=launcher.pluginUpdatePending===true;}catch{}
    send(res,200,{...config,version,pluginUpdatePending,phoneCaptureEnabled,wechatEnabled:wechat.enabled,cloudConfigured:!!token,byokConfigured:!!await resolve('byok'),account,accountError,update,phoneSync:phoneSync.status(),...await diagnostic()});return;
   }
   if(req.method!=='POST'||!String(req.headers['content-type']).startsWith('application/json'))throw error(404);
   const b=await body(req,8192);
   if(req.url==='/api/phone/capture'){
    if(typeof b.enabled!=='boolean')throw error(400);
    await locked(async()=>{const path=join(stateDir,'phone-capture.json');await writeFile(path+'.tmp',JSON.stringify({enabled:b.enabled}));await rename(path+'.tmp',path);});send(res,200,{enabled:b.enabled});return;
   }
   if(req.url==='/api/update/check'){
    let launcher;try{launcher=JSON.parse(await readFile(join(stateDir,'launcher-state.json'),'utf8'));}catch{}
    if(!launcher||Date.now()-launcher.updatedAt>30000||['stopped','error','legacy-active'].includes(launcher.phase))throw error(409);
    const path=join(stateDir,'launcher-control.json');await writeFile(path+'.tmp',JSON.stringify({action:'check-update',at:Date.now()}));await rename(path+'.tmp',path);
    send(res,202,{message:'已请求检查更新，下载完成后下次启动生效。'});return;
   }
   if(req.url==='/api/logout')await phoneSync.disable();
   const value=await locked(async()=>{
    if(req.url==='/api/sync/disable'){
     // Avoid calling credential renewal while holding the mutation lock.
     return {disableSync:true};
    }
    if(req.url==='/api/sync/enable')return {enableSync:true};
    if(req.url==='/api/model'){
     if(!['demo','byok','cloud'].includes(b.mode))throw error(400);
     const next={mode:b.mode,baseUrl:'',model:''};
     if(b.mode==='byok'){
      const endpoint=chatUrl(b.baseUrl);if(endpoint.origin===service.origin)throw error(400);
      if(typeof b.model!=='string'||b.model.length<1||b.model.length>120)throw error(400);
      next.baseUrl=b.baseUrl;next.model=b.model;
      if(b.apiKey!==undefined){if(typeof b.apiKey!=='string'||!b.apiKey.trim()||b.apiKey.length>4096)throw error(400);await credentials.set(refs.byok,b.apiKey.trim());}
      if(!await resolve('byok'))throw error(401);
     }
     if(b.mode==='cloud'&&!await resolve('cloud'))throw error(401);
     await saveConfig(next);return {saved:true};
    }
    if(req.url==='/api/login/ip'){
     const result=await remote('/desktop/auth/ip/register',null,{});
     await acceptCloud(result);
     return {status:'approved',nickname:result.nickname,seat:result.seat,seats:result.seats,modelLimit:result.modelLimit};
    }
    if(req.url==='/api/login/code'){
     if(typeof b.activationCode!=='string')throw error(400);
     const activationCode=b.activationCode.trim().toUpperCase();
     if(!/^JB-[A-F0-9]{32}$/.test(activationCode))throw error(400);
     const result=await remote('/desktop/auth/code/redeem',null,{activationCode});
     await acceptCloud(result);return {status:'approved'};
    }
    if(req.url==='/api/login/start'){
     pairing=await remote('/desktop/auth/device/start',null,{deviceName:hostname().slice(0,80)});
     return {userCode:pairing.userCode,expiresIn:pairing.expiresIn};
    }
    if(req.url==='/api/login/wechat/start'){
     const result=await remote('/desktop/auth/wechat/start',null,{deviceName:hostname().slice(0,80)});
     const authorize=new URL(result.authorizationUrl);
     if(authorize.origin!=='https://open.weixin.qq.com'||authorize.pathname!=='/connect/qrconnect'||authorize.username||authorize.password||typeof result.deviceSecret!=='string'||!Number.isFinite(result.expiresIn))throw error(502);
     pairing=result;
     return {authorizationUrl:authorize.href,expiresIn:result.expiresIn};
    }
    if(req.url==='/api/login/poll'){
     if(!pairing)throw error(410);
     const result=await remote('/desktop/auth/device/poll',null,{deviceSecret:pairing.deviceSecret});
     if(result.status==='approved'){await acceptLinkedLogin(result);return {status:'approved'};}
     return {status:'pending'};
    }
    if(req.url==='/api/logout'){
     const token=await resolve('cloud');if(token)await remote('/desktop/auth/logout',token,{});
     const linked=await resolve('sync');if(linked&&linked!==token)await remote('/desktop/auth/logout',linked,{}).catch(()=>{});
     await credentials.unset(refs.sync);await rm(join(stateDir,'sync-login.json'),{force:true});
     await credentials.unset(refs.cloud);await rm(join(stateDir,'cloud-login.json'),{force:true});nextRenewAttempt=0;pairing=null;return {loggedOut:true};
    }
    throw error(404);
   });
   if(value?.disableSync){await phoneSync.disable();send(res,200,{disabled:true});return;}
   if(value?.enableSync){await phoneSync.enable();send(res,200,{enabled:true});return;}
   send(res,200,value);
  }catch(e){if(res.headersSent){res.destroy();return;}const status=[400,401,403,404,409,410,413,429,502,503].includes(e.status)?e.status:503;send(res,status,{error:status===401?'请登录或配置模型密钥':status===403?'配置访问被拒绝':status===409?'请先配置模型或重新生成配对码':status===410?'配对码已过期':status===429?'首批体验名额已满或请求过于频繁':status===400?'配置格式不正确':'连接失败，请稍后重试'});}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 const url='http://127.0.0.1:'+server.address().port+'/#'+nonce;
 await writeFile(join(stateDir,'settings-link.txt'),url,{mode:0o600});
 return {url,port:server.address().port,close:async()=>{await phoneSync.close();await overlay.close();await new Promise(r=>{server.closeAllConnections();server.close(r);});}};
}
