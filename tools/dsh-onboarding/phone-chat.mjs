import {readFile,writeFile,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {limitedJson} from '../dsh-game-services/client.mjs';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fingerprint=token=>createHash('sha256').update(token).digest('hex');
export async function createPhoneChat({stateDir,deviceId,getToken,view,ask,serviceBaseUrl,fetchImpl=fetch,enabled=()=>true,pollMs=3000}){
  const file=join(stateDir,'phone-chat-receipt.json');
  let receipt=null,closed=false,busy=false,task=Promise.resolve(),nextAttempt=0;
  try{receipt=JSON.parse(await readFile(file,'utf8'));if(receipt?.status==='running')receipt={...receipt,status:'failed',error:'desktop_restarted'};}catch{}
  async function save(){await writeFile(file+'.tmp',JSON.stringify(receipt),{mode:0o600});await rename(file+'.tmp',file);}
  async function remote(path,token,data){
    const response=await fetchImpl(new URL('/desktop/sync/devices/'+deviceId+'/chat/'+path,serviceBaseUrl),{
      method:data?'POST':'GET',headers:{Authorization:'Bearer '+token,...(data?{'Content-Type':'application/json'}:{})},
      ...(data?{body:JSON.stringify(data)}:{}),redirect:'error',signal:AbortSignal.timeout(10000),
    });
    if(!response.ok){await response.body?.cancel();throw Object.assign(Error('phone chat unavailable'),{status:response.status});}
    return limitedJson(response,16384);
  }
  async function tick(){
    if(closed||busy||!enabled()||Date.now()<nextAttempt)return;
    busy=true;
    try{
      const token=await getToken();if(!/^jd_[a-f0-9]{64}$/.test(token??''))return;
      if(receipt&&receipt.account!==fingerprint(token)){receipt=null;await rm(file,{force:true});}
      if(!receipt){
        const {request}=await remote('next',token);if(!request)return;
        if(!UUID.test(request.id??'')||!UUID.test(request.lease??'')||!['lol','wzry'].includes(request.game)||typeof request.match!=='string'||!request.match||request.match.length>300||typeof request.question!=='string'||!request.question.trim()||request.question.length>1000||!Number.isFinite(request.leaseUntil))return;
        receipt={...request,account:fingerprint(token),status:'running'};await save();
      }
      if(receipt.status==='running'){
        const snapshot=view();
        if((snapshot.game||'lol')!==receipt.game||(snapshot.match||'waiting')!==receipt.match){receipt={...receipt,status:'failed',error:'match_changed'};}
        else if(Date.now()>receipt.leaseUntil){receipt={...receipt,status:'failed',error:'request_expired'};}
        else try{
          const result=await ask(receipt.question,undefined,{origin:'phone',requestId:receipt.id});
          receipt={...receipt,status:'complete',answer:result.answer};
        }catch(error){
          if(error.status===409&&view().match===snapshot.match)return;
          receipt={...receipt,status:'failed',error:error.status===409?'match_changed':'agent_unavailable'};
        }
        await save();
      }
      // Recheck binding after a potentially long native Agent turn.
      if(fingerprint(await getToken()??'')!==receipt.account)return;
      await remote(receipt.id+'/result',token,{lease:receipt.lease,status:receipt.status,answer:receipt.answer??'',...(receipt.status==='failed'?{error:receipt.error}:{})});
      receipt=null;await rm(file,{force:true});
    }catch(error){nextAttempt=Date.now()+([401,403,404].includes(error.status)?60000:10000);}
    finally{busy=false;}
  }
  const run=()=>{if(!busy)task=tick();return task;};
  const timer=setInterval(run,pollMs);timer.unref();
  return {tick:run,close:async()=>{closed=true;clearInterval(timer);await task.catch(()=>{});}};
}
