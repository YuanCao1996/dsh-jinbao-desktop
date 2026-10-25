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
const credentials=await createCredentials(stateDir),memory=createGameMemory(stateDir);let setup;
const observation=createDesktopObservation({stateDir,view:()=>setup?.view()??{}});
const nativeInstaller=createNativeInstaller({root,stateDir});
const logSource=await createExternalLogSource({stateDir,publish:event=>appendFile(join(stateDir,'logs/external-live.jsonl'),JSON.stringify(event)+'\n',{mode:0o600})});
const context=(game,match)=>memory.currentFacts(game,match),queryEvents=createEventQuery(memory),specializedCapture=createCloudCapture({stateDir,readState:()=>setup?.view()}),capture=request=>request.game==='generic'?observation.capture(request):specializedCapture(request);
const isCurrent=(game,match)=>{const v=setup?.view();return (v?.game||'lol')===game&&(v?.match||'waiting')===match;};
const userMemory=createUserMemory({stateDir,memory,isCurrent});
const onProgress=event=>createAgentStatus(stateDir,event.game,event.match)(event.event==='completed'?'complete':event.event==='tool_start'?'tool':'start',event.name);
const agent=createRuntimeRouter({getMode:()=>setup?.config().mode??'cloud',isCurrent,factories:{
 cloud:()=>createCloudAgent({apiPrefix:'/desktop/agent-preview',deviceId:stateDir,getToken:async()=>(await credentials.resolve('JINBAO_SERVICE_TOKEN'))?.value,getContext:context,queryEvents,isCurrent,capture,onProgress,memoryTools:userMemory.execute,observationPlan:args=>observation.plan(args)}),
 byok:()=>createLocalAgent({stateDir,getConfig:()=>setup.config(),getKey:async()=>(await credentials.resolve('JINBAO_USER_MODEL_API_KEY'))?.value,getContext:context,queryEvents,isCurrent,capture,onProgress,memoryTools:userMemory.execute,search:query=>setup.search(query),webSearch:createWebSearch(),observationPlan:args=>observation.plan(args)}),
}});
const updates=createStandaloneUpdates({root,stateDir,restart:process.connected?async()=>{process.send({action:'restart-update'});await writeFile(join(stateDir,'overlay-control.json'),JSON.stringify({action:'exit',at:Date.now()}));setTimeout(()=>void stop(),500);}:null});
setup=await createSetupServer({credentials,stateDir,port,cloudAgent:agent,localAgent:agent,runtimeId:'standalone',prepareModel:async config=>{if(config.mode==='byok')try{await locateNativeModules({stateDir,desktopPath:config.desktopPath});const validation=await createLocalAgent({stateDir,getConfig:()=>config,getKey:async()=>'',getContext:async()=>({})});await validation.close();}catch{throw Object.assign(Error('Local DSH unavailable'),{status:409,code:'local_dsh_unavailable'});}},onModelChange:()=>agent.reconfigure(),updateController:updates,observation,nativeInstaller,logSource,userMemory});
const version=JSON.parse(await readFile(join(root,'package.json'),'utf8')).version+' (独立预览)';
// Reuse the server's existing IP-based trial seats. A remembered login or an
// explicit local-mode choice always wins; exhausted seats fall back to email UI.
const loginTask=!args.includes('--headless')?setup.ensureTrialLogin().catch(()=>{}):Promise.resolve();
await writeFile(join(stateDir,'launcher-state.json'),JSON.stringify({phase:'cloud-preview',version,updatedAt:Date.now()}));
const heartbeat=setInterval(()=>void writeFile(join(stateDir,'launcher-state.json'),JSON.stringify({phase:'standalone',version,updatedAt:Date.now()})).catch(()=>{}),5000);
const updateTimer=setInterval(()=>void updates.check(),6*60*60*1000);void updates.check();
const observationTimer=setInterval(()=>{void observation.tick();void logSource.tick();},500);
await rm(join(stateDir,'overlay-stopped'),{force:true});
const coach=args.includes('--coach')?createCloudCoach({stateDir,view:setup.view,getContext:(game,match)=>memory.currentFacts(game,match),agent,enabled:()=>setup.config().mode!=='demo'}):null;
const coachTimer=coach?setInterval(()=>void coach.tick(),3000):null;
const supervisor=args.includes('--collect')?createSupervisor({root,stateDir}):null;
const interval=supervisor?setInterval(()=>void supervisor.tick().catch(()=>{}),3000):null;
if(!args.includes('--headless')){
 execFile('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'tools/desktop-release/start-overlay.ps1'),'-StateDir',stateDir],{windowsHide:true},()=>{});
 execFile('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'tools/jinbao-launcher/platform.ps1'),'-Action','open','-Target',setup.url],{windowsHide:true},()=>{});
}
console.log(JSON.stringify({standalone:true,requiresDshDesktop:false,stateDir,port:setup.port,collecting:!!supervisor}));
if(process.connected)process.send({action:'ready'});
let stopping=false;
const stop=async()=>{if(stopping)return;stopping=true;if(interval)clearInterval(interval);if(coachTimer)clearInterval(coachTimer);clearInterval(stopTimer);clearInterval(heartbeat);clearInterval(updateTimer);clearInterval(observationTimer);coach?.close();await agent.close();await userMemory.close();await supervisor?.close();await updates.close();await observation.close();await logSource.close();await nativeInstaller.close();await loginTask;await setup.close();await instance.close();process.exit(0);};
const stopTimer=setInterval(()=>void access(join(stateDir,'overlay-stopped')).then(stop).catch(()=>{}),500);
process.once('SIGINT',stop);process.once('SIGTERM',stop);
if(process.connected){process.once('disconnect',stop);process.on('message',message=>{if(message?.action==='stop')void stop();});}
}
