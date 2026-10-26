import test from 'node:test';import assert from 'node:assert/strict';
import {createRuntimeRouter} from '../runtime-router.mjs';
import {createShutdown,notifyRestart} from '../shutdown.mjs';
import {createSetupServer} from '../../dsh-onboarding/server.mjs';
import {runEntry} from '../entry.mjs';import {EventEmitter} from 'node:events';
import {mkdtemp,rm,readFile} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
const flush=()=>new Promise(r=>setImmediate(r));
test('restart notice is withheld after cleanup failure and during ordinary exit',async()=>{
 const messages=[],send=(message,done)=>{messages.push(message);done();};
 assert.equal(await notifyRestart({requested:true,failed:['agent'],connected:true,send}),false);assert.equal(await notifyRestart({requested:false,failed:[],connected:true,send}),false);assert.equal(await notifyRestart({requested:true,failed:[],connected:false,send}),false);assert.deepEqual(messages,[]);
});
test('successful restart notification waits for the IPC flush and tolerates a lost parent',async()=>{
 let flushed,finished=false;const sending=notifyRestart({requested:true,failed:[],connected:true,send:(message,done)=>{assert.equal(message.action,'restart-update');flushed=done;}}).then(value=>{finished=true;return value;});await flush();assert.equal(finished,false);flushed();assert.equal(await sending,true);assert.equal(await notifyRestart({requested:true,failed:[],connected:true,send:()=>{throw Error('closed');}}),false);
});
test('managed update restart stops when the previous runtime reports cleanup failure',async()=>{
 const stateDir=await mkdtemp(join(tmpdir(),'jinbao-exit-guard-'));let spawns=0;
 try{const code=await runEntry({root:stateDir,stateDir,updater:{resolve:async()=>stateDir},spawnImpl:()=>{const child=new EventEmitter();child.kill=()=>child.emit('exit',1);const launch=++spawns;setImmediate(()=>{child.emit('message',{action:'ready'});if(launch===1)child.emit('message',{action:'restart-update'});child.emit('exit',launch===1?1:0);});return child;}});assert.equal(code,1);assert.equal(spawns,1);}finally{await rm(stateDir,{recursive:true,force:true});}
});
test('a signal-terminated ready runtime is not reported as a clean exit',async()=>{
 const stateDir=await mkdtemp(join(tmpdir(),'jinbao-signal-guard-'));
 try{const code=await runEntry({root:stateDir,stateDir,updater:{resolve:async()=>stateDir},spawnImpl:()=>{const child=new EventEmitter();child.kill=()=>{};setImmediate(()=>{child.emit('message',{action:'ready'});child.emit('exit',null,'SIGTERM');});return child;}});assert.equal(code,1);}finally{await rm(stateDir,{recursive:true,force:true});}
});
test('shutdown failure still releases later resources and never records secret error details',async()=>{
 const calls=[];let saved;
 const stop=createShutdown({quiesce:()=>calls.push('intake-stopped'),steps:[['agent',async()=>{calls.push('agent');throw Error('SECRET-DO-NOT-LOG');}],['collectors',async()=>calls.push('collectors')],['instance',async()=>calls.push('instance')]],complete:result=>{saved=result;}});
 assert.deepEqual(await stop(),{failed:['agent']});assert.deepEqual(calls,['intake-stopped','agent','collectors','instance']);assert.ok(!JSON.stringify(saved).includes('SECRET'));
});
test('concurrent stop signals share one complete cleanup sequence',async()=>{
 let release,completed=0,disposed=0;const stop=createShutdown({steps:[['agent',()=>new Promise(r=>{disposed++;release=r;})]],complete:()=>completed++});const a=stop(),b=stop();assert.equal(a,b);await flush();release();await Promise.all([a,b,stop()]);assert.equal(disposed,1);assert.equal(completed,1);
});
test('settings intake stops immediately while remaining resources are still being cleaned',async()=>{
 const stateDir=await mkdtemp(join(tmpdir(),'jinbao-shutdown-http-'));let setup;
 try{setup=await createSetupServer({stateDir,port:0,credentials:{resolve:async()=>undefined,set:async()=>{},unset:async()=>{}},fetchImpl:async()=>Response.json({})});const url=new URL(setup.url);assert.equal((await fetch(url.origin)).status,200);setup.stopAccepting();await assert.rejects(fetch(url.origin,{signal:AbortSignal.timeout(1000)}));}
 finally{await setup?.close();await rm(stateDir,{recursive:true,force:true});}
});
test('shutdown drains an already accepted model save before releasing the settings service',{timeout:5000},async()=>{
 const stateDir=await mkdtemp(join(tmpdir(),'jinbao-save-close-'));let setup,release,started,closed=false;const ready=new Promise(r=>started=r),values=new Map();
 try{setup=await createSetupServer({stateDir,port:0,credentials:{resolve:async k=>values.has(k)?{value:values.get(k)}:undefined,set:async(k,v)=>values.set(k,v),unset:async k=>values.delete(k)},prepareModel:async()=>{started();await new Promise(r=>release=r);},fetchImpl:async()=>Response.json({})});const url=new URL(setup.url);const response=fetch(url.origin+'/api/model',{method:'POST',headers:{'Content-Type':'application/json','x-jinbao-setup':url.hash.slice(1)},body:JSON.stringify({mode:'byok',baseUrl:'https://model.example/v1',model:'fixture',apiKey:'test-only-key'})}).catch(()=>null);await ready;const ending=setup.close().then(()=>closed=true);await flush();assert.equal(closed,false);release();await ending;await response;assert.equal(JSON.parse(await readFile(join(stateDir,'settings.json'))).mode,'byok');await assert.rejects(setup.ensureTrialLogin(),e=>e.status===409);}
 finally{release?.();await setup?.close();await rm(stateDir,{recursive:true,force:true});}
});

test('reconfiguration fences new calls until the previous runtime has closed',async()=>{
 let mode='cloud',release,created=0;const calls=[];
 const router=createRuntimeRouter({getMode:()=>mode,factories:{cloud:()=>{created++;return{ask:async r=>{calls.push('cloud:'+r.question);return 'cloud';},close:()=>new Promise(r=>release=r)};},byok:()=>{created++;return{ask:async r=>{calls.push('byok:'+r.question);return 'byok';},close:async()=>{}};}}});
 try{await router.ask({topic:'chat',question:'first'});mode='byok';const switching=router.reconfigure();await flush();const next=router.ask({topic:'chat',question:'second'});await flush();assert.equal(created,1);assert.deepEqual(calls,['cloud:first']);release();await switching;assert.equal(await next,'byok');assert.equal(created,2);}finally{release?.();await router.close();}
});

test('shutdown waits for an opening runtime to be disposed and never starts its model',async()=>{
 let open,dispose,closed=false,modelCalls=0,closeCalls=0;
 const router=createRuntimeRouter({getMode:()=> 'cloud',factories:{cloud:()=>new Promise(resolve=>open=()=>resolve({ask:async()=>{modelCalls++;return 'unexpected';},close:async()=>{closeCalls++;await new Promise(r=>dispose=r);}}))}});
 const task=router.ask({topic:'chat',question:'opening'}),failed=assert.rejects(task,e=>e.status===409);while(!open)await flush();const ending=router.close().then(()=>closed=true);await flush();assert.equal(closed,false);open();while(!dispose)await flush();assert.equal(closed,false);dispose();await ending;await failed;assert.equal(modelCalls,0);assert.equal(closeCalls,1);
});

test('a late mode lookup cannot create a runtime after shutdown',async()=>{
 let readMode,created=0;const router=createRuntimeRouter({getMode:()=>new Promise(r=>readMode=r),factories:{cloud:()=>{created++;return{ask:async()=> 'bad',close:async()=>{}};}}});const task=router.ask({topic:'chat'}),failed=assert.rejects(task);while(!readMode)await flush();await router.close();readMode('cloud');await failed;assert.equal(created,0);
});
test('model switch between factory resolution and dispatch cancels with a normal status',async()=>{
 let open,switching,modelCalls=0;const router=createRuntimeRouter({getMode:()=> 'cloud',factories:{cloud:()=>new Promise(resolve=>open=()=>resolve({ask:async()=>{modelCalls++;return 'bad';},close:async()=>{}}))}});const task=router.ask({topic:'chat'}),failed=assert.rejects(task,e=>e.status===409);while(!open)await flush();open();queueMicrotask(()=>{switching=router.reconfigure();});await failed;await switching;assert.equal(modelCalls,0);await router.close();
});
test('disposal failure during startup shutdown reaches the cleanup caller',async()=>{
 let open;const error=Error('fixture-dispose-failure');const router=createRuntimeRouter({getMode:()=> 'cloud',factories:{cloud:()=>new Promise(resolve=>open=()=>resolve({ask:async()=> 'bad',close:async()=>{throw error;}}))}});const task=router.ask({topic:'chat'}),failed=assert.rejects(task,e=>e===error);while(!open)await flush();const ending=assert.rejects(router.close(),e=>e===error);open();await Promise.all([failed,ending]);
});
