// Close every owned resource even when an earlier disposer rejects. Diagnostics
// contain only step names, never provider errors, paths or credentials.
export function createShutdown({quiesce=()=>{},steps,complete=()=>{}}){
 let pending;
 return ()=>{
  if(!pending)pending=(async()=>{
   const failed=[];
   try{await quiesce();}catch{failed.push('quiesce');}
   for(const [name,close]of steps){try{await close();}catch{failed.push(name);}}
   const result={failed};await complete(result);return result;
  })();
  return pending;
 };
}

// Older managed entries trust this message regardless of exit status. Announce
// a restart only after all cleanup has succeeded, and flush IPC before exiting.
export async function notifyRestart({requested,failed,connected,send}){
 if(!requested||failed.length||!connected)return false;
 return new Promise(resolve=>{try{send({action:'restart-update'},error=>resolve(!error));}catch{resolve(false);}});
}
