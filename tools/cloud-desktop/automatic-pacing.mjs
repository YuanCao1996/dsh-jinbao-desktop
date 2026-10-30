export const isAutomatic=request=>request.automatic===true||(request.priority!=='manual'&&['advice','equipment'].includes(request.topic));
// One shared admission gate for coach and background builds; never queue here.
export function createAutomaticPacing({now=Date.now,busy=()=>false,intervalMs=60000,onSkip=()=>{}}={}){
 let active=false,nextAt=-Infinity;
 const allowed=()=>!active&&now()>=nextAt&&!busy();
 return {canRequest:allowed,status:()=>({active,nextAt:Number.isFinite(nextAt)?nextAt:0,intervalMs}),
  async run(request,execute){
   if(!isAutomatic(request))return execute(request);
   if(!allowed()){
    try{onSkip(request);}catch{}
    throw Object.assign(Error('Automatic analysis deferred'),{code:'auto_deferred',status:409,retryAt:Math.max(now()+3000,Number.isFinite(nextAt)?nextAt:0)});
   }
   active=true;
   try{return await execute({...request,automatic:true});}
   finally{active=false;nextAt=now()+intervalMs;}
  },
 };
}
