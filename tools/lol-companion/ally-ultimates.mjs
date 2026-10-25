export function createAllyUltimateObserver(emit,{now=Date.now}={}){
 const heroes=new Map();
 return{reset(){heroes.clear();},observe(frame,state,expectedKey){
  const captured=frame?.capturedAt;
  if(state?.sideSource!=='activePlayer.team'||!frame?.available||!frame.foreground||!expectedKey||frame.allyHud?.key!==expectedKey||!Number.isFinite(captured)||now()-captured>4000||captured>now()+500){for(const h of heroes.values())h.count=0;return;}
  const roster=new Map((state.allies??[]).filter(p=>p.championAlias&&p.championAlias!==state.me?.championAlias).map(p=>[p.championAlias,p]));
  const seen=new Set();
  for(const observation of (frame.allyHud.observations??[]).slice(0,5)){
   const alias=observation.alias,player=roster.get(alias);
   if(seen.has(alias)||!player||typeof observation.ready!=='boolean'||!(observation.portraitScore>=.8)||!(observation.indicatorScore>=.3))continue;seen.add(alias);
   let saved=heroes.get(alias);if(!saved){saved={at:0,count:0,ready:undefined,notified:false,lastAlert:-Infinity};heroes.set(alias,saved);}
   if(captured<=saved.at)continue;
   saved.count=saved.candidate===observation.ready&&captured-saved.at<=3500?saved.count+1:1;saved.candidate=observation.ready;const gap=captured-saved.at;saved.at=captured;
   if(saved.count<2||gap<150)continue;
   if(saved.ready!==observation.ready){saved.ready=observation.ready;if(!saved.ready)saved.notified=false;}
   const notify=saved.ready&&!saved.notified&&player.dead===false&&now()-saved.lastAlert>=30000;
   if(notify){saved.notified=true;saved.lastAlert=now();}
   if(notify||saved.lastPublishedReady!==saved.ready){
    saved.lastPublishedReady=saved.ready;
    emit({kind:'ally_ultimate',champion:player.champion,championAlias:alias,ready:saved.ready,notify,source:'hud-indicator',confidence:'high',capturedAt:captured,gameTime:state.gameTime});
   }
  }
  for(const [alias,saved] of heroes)if(!seen.has(alias))saved.count=0;
 }};
}
