import {appendFile,mkdir}from'node:fs/promises';import{join}from'node:path';import{randomUUID}from'node:crypto';
import{createWindowObserver}from'../game-observation/windows.mjs';import{createAdaptiveScheduler}from'../game-observation/adaptive.mjs';
import{visualSignature,significantChange}from'../game-observation/visual-change.mjs';
export function createDesktopObservation({stateDir,view,observer=createWindowObserver({enabled:true}),now=Date.now,publish=event=>appendFile(join(stateDir,'logs/generic.jsonl'),JSON.stringify(event)+'\n',{mode:0o600})}){
 let session=null,busy=false,frame=null,signature=null,revision=0,scheduler=null,closed=false;
 const specialized=()=>{const v=view();return ['lol','wzry'].includes(v.game)&&!v.ended&&v.match&&now()-v.updatedAt<30000;};
 const event=(kind,extra={})=>({game:'generic',match:session.match,t:now(),kind,...extra});
 async function stop(){if(session)await publish(event('event',{name:'GameEnd'}));session=null;frame=null;observer.clear();}
 return{list:()=>observer.list(),status:()=>({enabled:!!session,targetId:session?.target.id,windowTitle:session?.target.title,match:session?.match,scheduler:scheduler?.status()}),
  async start({targetId,authorized}){if(closed||authorized!==true||specialized())throw Object.assign(Error('Window unavailable'),{status:409});await stop();const target=await observer.select({id:targetId,authorized:true});session={target,match:'generic-'+randomUUID()};signature=null;revision=0;scheduler=createAdaptiveScheduler({now});await mkdir(join(stateDir,'logs'),{recursive:true});await publish(event('game_start',{phase:'Observing',genericState:{windowTitle:target.title,identity:'unconfirmed',observationRevision:0}}));return this.status();},
  async stop(){await stop();return{enabled:false};},
  plan(value){if(!session)throw Error('No selected window');return scheduler.propose(value);},
  async tick(){
   if(closed||!session||busy)return;busy=true;const owner=session;
   try{
    if(specialized()){await stop();return;}
    const windows=await observer.list(),current=windows.find(w=>w.id===owner.target.id);if(!current){await stop();return;}
    const admission=scheduler.admit({active:current.foreground});if(!admission.allowed)return;
    const result=await observer.capture(admission.request);if(session!==owner||closed)return;
    const next=visualSignature(result.image),changed=!signature||significantChange(signature,next);signature=next;scheduler.complete({changed,ok:true});if(changed)revision++;
    const image=result.png;if(image.length<=1048576)frame={game:'generic',match:owner.match,captured_at_ms:result.frame.captured_at_ms,image_base64:image.toString('base64'),media_type:'image/png'};
    await publish(event('state',{state:{genericState:{windowTitle:owner.target.title,identity:'unconfirmed',observationRevision:revision,capturedAt:now(),changed,quality:admission.request.quality}}}));
   }catch{scheduler?.complete({ok:false});frame=null;}finally{busy=false;}
  },async capture({game,match}){if(game!=='generic'||!session||session.match!==match)return null;await this.tick();return frame&&now()-frame.captured_at_ms<10000?{...frame}:null;},
  async close(){closed=true;await stop();}};
}
