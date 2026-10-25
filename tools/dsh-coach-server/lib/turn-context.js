export function turnContext(context){
 const clip=(v,n=120)=>typeof v==='string'?v.slice(0,n):v;
 const items=list=>(Array.isArray(list)?list:[]).slice(0,8).map(i=>typeof i==='string'?clip(i):{name:clip(i.name),count:i.count});
 const player=p=>p?{champion:clip(p.champion),championAlias:clip(p.championAlias),tier:p.tier,winRate:p.winRate,roles:p.roles,spells:p.spells,dead:p.dead,canShop:p.canShop,championAugments:p.championAugments,respawn:p.respawn,level:p.level,k:p.k,d:p.d,a:p.a,gold:p.gold,hp:p.hp,hpPct:p.hpPct,items:items(p.items)}:undefined;
 const c=context.current;
 const result={...context,previousMatches:[],preferences:(context.preferences??[]).slice(-6),historyAvailableVia:'game_log_query / game_memory_query (past matches only on explicit user request)'};
 if(c)result.current={...c,me:player(c.me),allies:(c.allies??[]).slice(0,5).map(player),enemies:(c.enemies??[]).slice(0,5).map(player),bench:c.phase==='ChampSelect'?(c.bench??[]).slice(0,20).map(player):[],
 events:(c.events??[]).slice(-12).map(e=>({time:e.time,text:clip(e.text,240)})),broadcasts:(c.broadcasts??[]).slice(-3).map(e=>({text:clip(e.text,300)})),chat:(c.chat??[]).filter(e=>!e.failed).slice(-4).map(e=>({role:e.role,text:clip(e.text,500)})),knowledge:(c.knowledge??[]).slice(0,8).map(r=>Object.fromEntries(['_type','champion','name','rank','tier','winRate','items','augments'].filter(k=>r[k]!==undefined).map(k=>[k,typeof r[k]==='string'?clip(r[k],450):r[k]]))),contextReduced:true};
 for(const key of ['previousMatches','preferences'])while(JSON.stringify(result).length>9000&&result[key].length)result[key].shift();
 if(c){for(const key of ['knowledge','chat','broadcasts'])while(JSON.stringify(result).length>9000&&result.current[key].length)result.current[key].shift();while(JSON.stringify(result).length>9000&&result.current.events.length>4)result.current.events.shift();}
 return result;
}
