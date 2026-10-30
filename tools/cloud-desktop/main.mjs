import{createCloudCapture}from'./capture.mjs';
import{createCloudCoach}from'./auto-coach.mjs';
import{claimInstance}from'./instance.mjs';
import{createEventQuery}from'./event-query.mjs';
import{createRuntimeRouter}from'./runtime-router.mjs';
import{createLocalAgent}from'./local-agent.mjs';
import{locateNativeModules}from'./native-modules.mjs';
import{createWebSearch}from'./web-search.mjs';
import{createStandaloneUpdates}from'./updates.mjs';
import{createDesktopObservation}from'./observation.mjs';
import{createNativeInstaller}from'./native-installer.mjs';
import{access,rm,readFile,writeFile,appendFile}from'node:fs/promises';
import{createExternalLogSource}from'./log-source.mjs';
import{createUserMemory}from'./user-memory.mjs';
import{createAgentActivity}from'../agent-activity/activity.mjs';
import{createShutdown,notifyRestart}from'./shutdown.mjs';
import{createOverlaySupervisor}from'./overlay-supervisor.mjs';
import{createDiagnostics}from'./diagnostics.mjs';
import{createSpeech,cloudSpeech,ownSpeech}from'./speech.mjs';
import{createAutomaticPacing}from'./automatic-pacing.mjs';
import{createRoomCacheStore}from'../team-room/cache-store.mjs';
import{createCacheReportUploader}from'../team-room/cache-reports.mjs';
import{createHostUsageOutbox}from'../team-room/usage-outbox.mjs';
import{createSetupServer}from'../dsh-onboarding/server.mjs';import{createCredentials}from'./credentials.mjs';import{createCloudAgent}from'./cloud-agent.mjs';import{createGameMemory}from'../dsh-coach-server/lib/game-memory.js';
import{createSupervisor}from'../jinbao-launcher/supervisor.mjs';import{createAgentStatus}from'../dsh-coach-server/lib/agent-status.js';
import{resolve,join}from'node:path';import{homedir}from'node:os';import{fileURLToPath}from'node:url';import{execFile}from'node:child_process';
const root=fileURLToPath(new URL('../../',import.meta.url));const args=process.argv.slice(2);
const stateDir=resolve(args.includes('--state')?args[args.indexOf('--state')+1]:join(homedir(),'.jinbao-cloud-preview'));
const port=args.includes('--port')?Number(args[args.indexOf('--port')+1]):0;
const instance=await claimInstance(stateDir);
if(!instance.owned){
 if(!args.includes('--headless')){
  try{const link=(await readFile(join(stateDir,'settings-link.txt'),'utf8')).trim();if(/^http:\/\/127\.0\.0\.1:\d+\/#[a-f0-9]{64}$/.test(link))execFile('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'tools/jinbao-launcher/platform.ps1'),'-Action','open','-Target',link],{windowsHide:true},()=>{});}catch{}
  execFile('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'tools/desktop-release/start-overlay.ps1'),'-StateDir',stateDir],{windowsHide:true},()=>{});
 }
 await instance.close();console.log(JSON.stringify({alreadyRunning:true}));
}else{
let teamCacheStore=null,cacheDiagnostics=null;const cacheEvents=[];
const cacheTrace=value=>{const action=({team_cache_content_deleted:'cache_deleted',team_cache_report_received:'cache_report_received',team_cache_report_pending:'cache_report_pending',team_usage_report_received:'usage_report_received',team_usage_report_pending:'usage_report_pending'})[value.event]??'cache_cleanup_pending';const event=value.event.startsWith('team_usage_')?'usage':'cache';if(cacheDiagnostics)cacheDiagnostics.record(event,{action});else if(cacheEvents.length<20)cacheEvents.push({event,action});};
try{teamCacheStore=await createRoomCacheStore({stateDir,trace:cacheTrace});}catch{cacheTrace({event:'team_cache_cleanup_pending'});}
const credentials=await createCredentials(stateDir),memory=createGameMemory(stateDir);let setup;
let teamCacheReports=null;try{if(teamCacheStore)teamCacheReports=await createCacheReportUploader({credentials,cacheStore:teamCacheStore,trace:cacheTrace});}catch{cacheTrace({event:'team_cache_report_pending'});}
let teamUsageOutbox=null;try{teamUsageOutbox=await createHostUsageOutbox({credentials,trace:cacheTrace});}catch{cacheTrace({event:'team_usage_report_pending'});}
const observation=createDesktopObservation({stateDir,trace:value=>diagnostics.record('observation',value),view:()=>setup?.view()??{}});
const nativeInstaller=createNativeInstaller({root,stateDir});
const logSource=await createExternalLogSource({stateDir,publish:event=>appendFile(join(stateDir,'logs/external-live.jsonl'),JSON.stringify(event)+'\n',{mode:0o600})});
const context=(game,match)=>memory.currentFacts(game,match),queryEvents=createEventQuery(memory),specializedCapture=createCloudCapture({stateDir,readState:()=>setup?.view()}),capture=async request=>{const started=Date.now();try{const frame=await(request.game==='generic'?observation.capture(request):specializedCapture(request));diagnostics.record('capture',{game:request.game,match:request.match,available:!!frame,elapsedMs:Date.now()-started,ageMs:frame?.captured_at_ms?Date.now()-frame.captured_at_ms:undefined});return frame;}catch(error){diagnostics.record('capture',{game:request.game,match:request.match,available:false,reason:'capture_failed',elapsedMs:Date.now()-started});throw error;}};
const isCurrent=(game,match)=>{if(game==='generic'&&observation.status().enabled&&observation.status().match!==match)return false;const v=setup?.view();return (v?.game||'lol')===game&&(v?.match||'waiting')===match;};
const userMemory=createUserMemory({stateDir,memory,isCurrent});
const activity=await createAgentActivity({stateDir,getView:()=>setup?.view()});
const diagnostics=await createDiagnostics({stateDir,view:()=>setup?.view()??{},expectOverlay:!args.includes('--headless')});
cacheDiagnostics=diagnostics;for(const {event,action} of cacheEvents)diagnostics.record(event,{action});cacheEvents.length=0;
const officialSpeech=cloudSpeech({getToken:async()=>(await credentials.resolve('JINBAO_SERVICE_TOKEN'))?.value}),byokSpeech=ownSpeech({getKey:async()=>(await credentials.resolve('JINBAO_USER_SPEECH_API_KEY'))?.value});
const speech=await createSpeech({stateDir,view:()=>setup?.view()??{},synthesize:(text,role,signal,source)=>(source==='byok'?byokSpeech:officialSpeech)(text,role,signal),trace:event=>diagnostics.record('speech',{game:setup?.view().game,match:setup?.view().match,...event})});
const pacing=createAutomaticPacing({busy:()=>rawAgent.busy()||!speech.canAutoRequest(),onSkip:request=>diagnostics.record('coach',{game:request.game,match:request.match,action:'skip',reason:'output_backpressure'})});
const onProgress=event=>{diagnostics.accept(event);activity.accept(event);if(['generic_observation','public_text','budget_check','model_reserved','model_permission'].includes(event.event))return;return createAgentStatus(stateDir,event.game,event.match)(['completed','task_completed','task_cancelled','task_stale'].includes(event.event)?'complete':event.event==='task_failed'?'error':event.event==='tool_start'?'tool':'start',event.name);};
const rawAgent=createRuntimeRouter({getMode:()=>setup?.config().mode??'cloud',isCurrent,onEvent:onProgress,factories:{
 cloud:()=>createCloudAgent({getActivityEnabled:activity.isEnabled,apiPrefix:'/desktop/agent-preview',deviceId:stateDir,getToken:async()=>(await credentials.resolve('JINBAO_SERVICE_TOKEN'))?.value,getContext:context,queryEvents,isCurrent,capture,onObservation:value=>observation.feedback(value),onProgress,memoryTools:userMemory.execute,observationPlan:args=>observation.plan(args)}),
 byok:()=>createLocalAgent({stateDir,getConfig:()=>setup.config(),getKey:async()=>(await credentials.resolve('JINBAO_USER_MODEL_API_KEY'))?.value,getContext:context,queryEvents,isCurrent,capture,onObservation:value=>observation.feedback(value),onProgress,getActivityEnabled:activity.isEnabled,memoryTools:userMemory.execute,search:query=>setup.search(query),webSearch:createWebSearch(),observationPlan:args=>observation.plan(args)}),
}});
const agent={...rawAgent,ask:request=>pacing.run(request,async admitted=>{const role=speech.role(),answer=await rawAgent.ask({...admitted,role});if(role!==speech.role())throw Object.assign(Error('Role changed'),{status:409,code:'agent_preempted'});if(admitted.topic==='chat')speech.chat({...admitted,text:answer});return answer;})};
let restartRequested=false;
const updates=createStandaloneUpdates({root,stateDir,restart:process.connected?async()=>{await writeFile(join(stateDir,'overlay-control.json'),JSON.stringify({action:'exit',at:Date.now()}));restartRequested=true;setTimeout(()=>void stop(),500);}:null});
setup=await createSetupServer({credentials,stateDir,port,cloudAgent:agent,localAgent:agent,runtimeId:'standalone',teamRooms:args.includes('--team-rooms'),teamHostPreview:args.includes('--team-byok-host')&&!!teamCacheStore&&!!teamCacheReports&&!!teamUsageOutbox,teamCacheStore,teamCacheReports,teamUsageOutbox,teamUsageError:!teamUsageOutbox,teamCacheError:!teamCacheStore||!teamCacheReports,activity,diagnostics,speech,canAutoRequest:pacing.canRequest,prepareModel:async config=>{if(config.mode==='byok')try{await locateNativeModules({stateDir,desktopPath:config.desktopPath});const validation=await createLocalAgent({stateDir,getConfig:()=>config,getKey:async()=>'',getContext:async()=>({})});await validation.close();}catch{throw Object.assign(Error('Local DSH unavailable'),{status:409,code:'local_dsh_unavailable'});}},onModelChange:()=>agent.reconfigure(),updateController:updates,observation,nativeInstaller,logSource,userMemory});
const version=JSON.parse(await readFile(join(root,'package.json'),'utf8')).version+' (独立预览)';
// Reuse the server's existing IP-based trial seats. A remembered login or an
// explicit local-mode choice always wins; exhausted seats fall back to email UI.
const loginTask=!args.includes('--headless')?setup.ensureTrialLogin().catch(()=>{}):Promise.resolve();
await writeFile(join(stateDir,'launcher-state.json'),JSON.stringify({phase:'cloud-preview',version,updatedAt:Date.now()}));
const heartbeat=setInterval(()=>void writeFile(join(stateDir,'launcher-state.json'),JSON.stringify({phase:'standalone',version,updatedAt:Date.now()})).catch(()=>{}),5000);
const updateTimer=setInterval(()=>void updates.check(),6*60*60*1000);void updates.check();
const speechTimer=setInterval(()=>speech.tick(),500);
const diagnosticsTimer=setInterval(()=>void diagnostics.tick(),2000);
const observationTimer=setInterval(()=>{void observation.tick();void logSource.tick();},500);
await rm(join(stateDir,'overlay-stopped'),{force:true});
const coach=args.includes('--coach')?createCloudCoach({stateDir,canRequest:pacing.canRequest,trace:diagnostics.coach,view:setup.view,getContext:(game,match)=>memory.currentFacts(game,match),agent,enabled:()=>setup.config().mode!=='demo'}):null;
const coachTimer=coach?setInterval(()=>void coach.tick(),3000):null;
const supervisor=args.includes('--collect')?createSupervisor({root,stateDir}):null;
const interval=supervisor?setInterval(()=>void supervisor.tick().catch(()=>{}),3000):null;
const overlay=args.includes('--headless')?null:createOverlaySupervisor({stateDir,launch:recover=>new Promise((resolve,reject)=>{
 execFile('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'tools/desktop-release/start-overlay.ps1'),'-StateDir',stateDir,...(recover?['-Recover']:[])],{windowsHide:true},(error,stdout)=>error?reject(error):resolve({external:stdout.includes('Existing DSH Jinbao overlay restored.')}));
})});
const overlayTimer=overlay?setInterval(()=>void overlay.tick(),3000):null;
if(!args.includes('--headless')){
 void overlay.start();
 execFile('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'tools/jinbao-launcher/platform.ps1'),'-Action','open','-Target',setup.url],{windowsHide:true},()=>{});
}
console.log(JSON.stringify({standalone:true,requiresDshDesktop:false,stateDir,port:setup.port,collecting:!!supervisor}));
if(process.connected)process.send({action:'ready'});
const stop=createShutdown({
 quiesce:()=>{if(interval)clearInterval(interval);if(coachTimer)clearInterval(coachTimer);if(overlayTimer)clearInterval(overlayTimer);void overlay?.close();clearInterval(stopTimer);clearInterval(heartbeat);clearInterval(diagnosticsTimer);clearInterval(speechTimer);clearInterval(updateTimer);clearInterval(observationTimer);setup.stopAccepting();},
 steps:[['overlay',()=>overlay?.close()],['coach',()=>coach?.close()],['speech',()=>speech.close()],['agent',()=>agent.close()],['memory',()=>userMemory.close()],['collectors',()=>supervisor?.close()],['updates',()=>updates.close()],['observation',()=>observation.close()],['logs',()=>logSource.close()],['installer',()=>nativeInstaller.close()],['login',()=>loginTask],['settings',()=>setup.close()],['usage-outbox',()=>teamUsageOutbox?.close()],['cache-reports',()=>teamCacheReports?.close()],['team-cache',()=>teamCacheStore?.close()],['activity',()=>activity.close()],['diagnostics',()=>diagnostics.close()],['instance',()=>instance.close()]],
 complete:async({failed})=>{try{await writeFile(join(stateDir,'shutdown-state.json'),JSON.stringify({at:Date.now(),state:failed.length?'completed_with_errors':'completed',failedSteps:failed}),{mode:0o600});await notifyRestart({requested:restartRequested,failed,connected:process.connected,send:(...values)=>process.send(...values)});}finally{process.exit(failed.length?1:0);}}
});
const stopTimer=setInterval(()=>void access(join(stateDir,'overlay-stopped')).then(stop).catch(()=>{}),500);
process.once('SIGINT',stop);process.once('SIGTERM',stop);
if(process.connected){process.once('disconnect',stop);process.on('message',message=>{if(message?.action==='stop')void stop();});}
}
