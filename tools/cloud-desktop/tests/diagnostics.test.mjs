import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Script} from 'node:vm';
import {createDiagnostics} from '../diagnostics.mjs';
import {createSetupServer} from '../../dsh-onboarding/server.mjs';
import {createCloudCoach} from '../auto-coach.mjs';

async function fixture(t,options={}){
 const stateDir=await mkdtemp(join(tmpdir(),'jinbao-diagnostics-'));let at=100000;
 const view={game:'lol',match:'private-account-match',phase:'InProgress',updatedAt:at};
 const d=await createDiagnostics({stateDir,view:()=>view,now:()=>at,expectOverlay:false,...options});
 t.after(async()=>{await d.close();await rm(stateDir,{recursive:true,force:true});});
 return {d,stateDir,view,advance(ms){at+=ms;view.updatedAt=at;}};
}

test('diagnostics correlate tasks and tool timing without private payloads or display opt-in',async t=>{
 const f=await fixture(t);
 f.d.accept({event:'task_started',game:'lol',match:f.view.match,requestId:'secret-token',topic:'chat',question:'我的私密问题'});
 f.advance(300);f.d.accept({event:'tool_end',game:'lol',match:f.view.match,requestId:'secret-token',name:'web_search',elapsed_ms:200,args:{url:'http://internal.example'},text:'玩家名'});
 f.advance(700);f.d.accept({event:'task_failed',game:'lol',match:f.view.match,requestId:'secret-token',code:'model_quota_denied',message:'Bearer secret',httpStatus:429});
 f.d.accept({event:'public_text',text:'隐私回复',requestId:'secret-token'});
 const result=await f.d.export(),text=JSON.stringify(result);
 for(const secret of ['private-account-match','secret-token','我的私密问题','internal.example','玩家名','Bearer','隐私回复'])assert.ok(!text.includes(secret),secret);
 const rows=result.events.filter(e=>e.event==='agent');assert.equal(rows.length,3);
 assert.equal(rows[0].requestId,rows[2].requestId);assert.equal(rows[2].elapsedMs,1000);
 assert.equal(rows[1].elapsedMs,200);assert.equal(result.summary.taskFailures,1);assert.equal(result.summary.activeTasks,0);
});

test('cache cleanup diagnostics retain only the fixed action and never raw room names, paths, proof or content',async t=>{
 const f=await fixture(t);
 f.d.record('cache',{action:'cache_cleanup_pending',roomId:'private-room',path:'private-path',deviceSecret:'private-proof',text:'PRIVATE-CACHE'});
 f.d.record('cache',{action:'cache_deleted'});
 const exported=await f.d.export();assert.equal(exported.events.filter(row=>row.event==='cache').length,2);
 assert.doesNotMatch(JSON.stringify(exported),/private-room|private-path|private-proof|PRIVATE-CACHE/);
});

test('capture health, stale heartbeat, missing advice and issue bookmarks are persisted once per transition',async t=>{
 const f=await fixture(t,{expectOverlay:true});
 await writeFile(join(f.stateDir,'augment-diagnostics.json'),JSON.stringify({at:100000,recognized:3,knownSlots:3,elapsedMs:210,captureBackend:'window-client',lines:['私密OCR'],sequence:1}));
 await f.d.tick();f.advance(121000);await f.d.tick();await f.d.tick();
 f.d.mark('augments');assert.throws(()=>f.d.mark('secret'),e=>e.status===400);
 const result=await f.d.export();assert.equal(result.events.filter(e=>e.code==='advice_wait_long').length,1);
 assert.equal(result.events.filter(e=>e.code==='overlay_heartbeat_stale').length,1);
 assert.equal(result.events.find(e=>e.event==='capture').recognized,3);assert.ok(!JSON.stringify(result).includes('私密OCR'));
 assert.equal(result.summary.bookmarks,1);
 f.d.coach({game:'lol',match:f.view.match,action:'coach_published'});await f.d.tick();assert.ok(!f.d.status().alerts.includes('advice_wait_long'));
});

test('rotation, run retention and repeated idle skips stay bounded',async t=>{
 const f=await fixture(t,{maxFileBytes:600,maxFiles:2,maxRuns:2});
 for(let i=0;i<100;i++){f.d.record('snapshot',{sequence:i});await f.d.export();}
 const runDir=join(f.stateDir,'diagnostics',f.d.status().runId);
 assert.ok((await readdir(runDir)).filter(n=>n.endsWith('.jsonl')).length<=2);
 for(let i=0;i<100;i++)f.d.coach({action:'skip',reason:'busy'});
 await f.d.export();assert.equal((await f.d.export()).events.filter(e=>e.reason==='busy').length,1);
 await f.d.close();
 for(let i=0;i<3;i++){f.advance(1000);const d=await createDiagnostics({stateDir:f.stateDir,now:()=>100000+i*1000,maxRuns:2});await d.close();}
 assert.ok((await readdir(join(f.stateDir,'diagnostics'))).length<=2);
});

test('diagnostic IO failures do not prevent application startup or strategy completion',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jinbao-diagnostics-blocked-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await writeFile(join(dir,'diagnostics'),'blocked');const d=await createDiagnostics({stateDir:dir});
 assert.equal(d.status().recording,false);await d.tick();await d.close();
 const f=await fixture(t),entries=[];
 const current={...f.view,gameSeconds:180,me:{champion:'安妮',level:6},enemies:[],offers:[],ownedAugments:[]};
 const coach=createCloudCoach({view:()=>f.view,now:()=>100000,getContext:async()=>({current}),trace:()=>{throw Error('Disk unavailable');},agent:{ask:async()=> '等队友先控'},publish:async e=>entries.push(e)});
 await coach.tick();assert.equal(entries.length,1);coach.close();
});

test('export after restart includes the previous run so crash evidence is not lost',async t=>{
 const f=await fixture(t);f.d.mark('overlay');await f.d.close();
 const next=await createDiagnostics({stateDir:f.stateDir});t.after(()=>next.close());
 const result=await next.export();assert.equal(result.previousRuns.length,1);
 assert.ok(result.previousRuns[0].events.some(e=>e.event==='bookmark'&&e.kind==='overlay'));
 assert.ok(result.previousRuns[0].events.some(e=>e.event==='run_end'));
});

test('diagnostic endpoints require the local nonce and export only the fixed session',async t=>{
 const f=await fixture(t),values=new Map();
 const credentials={resolve:async k=>values.has(k)?{value:values.get(k)}:undefined,set:async(k,v)=>values.set(k,v),unset:async k=>values.delete(k)};
 const setup=await createSetupServer({stateDir:f.stateDir,port:0,credentials,diagnostics:f.d,runtimeId:'standalone',fetchImpl:async()=>Response.json({})});
 t.after(()=>setup.close());const [base,nonce]=setup.url.split('/#'),headers={'x-jinbao-setup':nonce};
 assert.equal((await fetch(base+'/api/diagnostics/export')).status,403);
 const mark=await fetch(base+'/api/diagnostics/mark',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({kind:'chat',text:'Do not save me'})});
 assert.equal(mark.status,200);
 const exported=await fetch(base+'/api/diagnostics/export',{headers});assert.equal(exported.status,200);
 assert.match(exported.headers.get('content-disposition'),/attachment/);
 const result=await exported.json();assert.equal(result.summary.bookmarks,1);assert.ok(!JSON.stringify(result).includes('Do not save me'));
 assert.equal((await fetch(base+'/api/diagnostics/export?path=credentials.json',{headers})).status,404);
 const html=await readFile(new URL('../../dsh-onboarding/settings.html',import.meta.url),'utf8');
 new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
 assert.match(html,/标记问题时间/);assert.match(html,/导出诊断记录/);
});
