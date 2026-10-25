import{writeFile,rename,mkdir}from'node:fs/promises';import{join}from'node:path';import{randomBytes}from'node:crypto';
export function createHudAssets({stateDir,load,now=Date.now}){
 let desired='',id='',generation=0,latest,task=null,closed=false,nextAttempt=0,complete=false;const cache=new Map(),stop=new AbortController();
 const write=async value=>{await mkdir(stateDir,{recursive:true});const file=join(stateDir,'ally-hud-catalogue.json');await writeFile(file+'.tmp',JSON.stringify(value),{mode:0o600});await rename(file+'.tmp',file);};
 function update(request){
  if(closed)return Promise.resolve();latest=request;
  const me=request.state.sideSource==='activePlayer.team'?request.state.me?.championAlias:null;
  const roster=me?[...new Map((request.state.allies??[]).filter(p=>p.championAlias&&p.championAlias!==me).map(p=>[p.championAlias,p])).values()].slice(0,5).map(p=>{
   const row=(request.champions??[]).find(c=>c.alias===p.championAlias);return{alias:p.championAlias,id:row?.id};
  }).filter(p=>/^[A-Za-z0-9_]{1,40}$/.test(p.alias)&&Number.isInteger(p.id)&&p.id>0&&p.id<1000000):[];
  const key=JSON.stringify([request.match,request.source,roster]);
  if(key!==desired){desired=key;id=randomBytes(16).toString('hex');generation++;nextAttempt=0;complete=false;}
  if(task||complete||now()<nextAttempt)return task??Promise.resolve();
  const epoch=generation,currentId=id;
  task=(async()=>{
   await write({key:currentId,portraits:[]});
   const portraits=await Promise.all(roster.map(async p=>{
    const key=request.source+':'+p.id;let bytes=cache.get(key);
    if(!bytes){try{bytes=await load(p.id,stop.signal);if(!Buffer.isBuffer(bytes)||bytes.length>65536||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return null;cache.set(key,bytes);if(cache.size>24)cache.delete(cache.keys().next().value);}catch{return null;}}
    return{alias:p.alias,png:bytes.toString('base64')};
   }));
   if(!closed&&epoch===generation){const valid=portraits.filter(Boolean);await write({key:currentId,portraits:valid});complete=valid.length===roster.length&&roster.length>=3;nextAttempt=now()+10000;}
  })().catch(()=>{nextAttempt=now()+10000;}).finally(()=>{task=null;if(!closed&&epoch!==generation)void update(latest);});return task;
 }
 return{update,key:()=>id,reset(){desired='';id='';generation++;complete=false;},async close(){closed=true;stop.abort();await task;}};
}
