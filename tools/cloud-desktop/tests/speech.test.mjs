import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runSpeechProcess} from '../speech-process.mjs';
import {createSpeech,cloudSpeech,ownSpeech} from '../speech.mjs';
import {roles,roleInstruction,speechSegments,speechPause} from '../roles.mjs';
import {agentQuestion} from '../cloud-agent.mjs';
import {createSetupServer} from '../../dsh-onboarding/server.mjs';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t,options={}){
 const stateDir=await mkdtemp(join(tmpdir(),'jinbao-speech-'));let time=10000;
 const view={game:'lol',match:'one',ended:false,updatedAt:time,playback:[]},calls=[],played=[],trace=[];
 const speech=await createSpeech({stateDir,view:()=>view,now:()=>time,minIntervalMs:0,synthesize:async(text,role,signal,source)=>{calls.push({text,role,signal,source});return{text};},play:async audio=>played.push(audio.text),trace:e=>trace.push(e),pause:async()=>{},...options});
 t.after(async()=>{await speech.close();await rm(stateDir,{recursive:true,force:true});});
 return{speech,stateDir,view,calls,played,trace,advance(ms){time+=ms;view.updatedAt=time;},message(id,text,priority=1){view.playback.push({id,text,priority,at:time,expiresAt:time+45000});}};
}

test('all four Android roles have the same voices and affect cloud/native prompts',()=>{
 assert.deepEqual(roles.map(r=>r.voice),['longanhuan','longqiang_v3','longtian_v3','longlaotie_v3']);
 assert.equal(roles.every(r=>r.model==='cosyvoice-v3-flash'),true);
 assert.match(agentQuestion({question:'怎么打',game:'lol',role:'liurufeng'}),/柳如风.*冷静知性/);
 assert.match(roleInstruction('tiezhi','wzry',true),/不发操作命令/);
 assert.equal(roleInstruction('malicious-role','lol'), '');
 assert.ok(speechSegments('甲'.repeat(1000),2).every(t=>t.length<=100));assert.equal(speechSegments('甲'.repeat(1000),2).length,2);
 assert.doesNotMatch(speechSegments('**开团** [提示](https://private) Bearer secret sk-private').join(''),/https|secret|sk-private/);
 assert.equal(speechPause('等队友。'),360);assert.equal(speechPause('等队友'),220);
});

test('muted intake does not build a backlog; new messages and chat play once with the selected role',async t=>{
 const f=await fixture(t);f.message('muted','旧建议');f.speech.tick();await f.speech.settle();assert.equal(f.calls.length,0);
 await f.speech.configure({enabled:true,role:'wangbatian'});f.message('new','等控制。');f.speech.tick();await f.speech.settle();f.speech.tick();await f.speech.settle();
 assert.deepEqual(f.played,['等控制。']);assert.equal(f.calls[0].role,'wangbatian');
 f.speech.chat({game:'lol',match:'one',text:'聊天回答。'});await f.speech.settle();assert.equal(f.played.at(-1),'聊天回答。');
 await f.speech.configure({chat:false});assert.equal(f.speech.chat({game:'lol',match:'one',text:'不读'}),false);
});

test('automatic advice is dropped instead of queuing behind current audio, even when urgent',async t=>{
 let release,firstSignal;const order=[];
 const f=await fixture(t,{play:async(audio,signal)=>{order.push(audio.text);if(order.length===1){firstSignal=signal;await new Promise(r=>release=r);}}});
 await f.speech.configure({enabled:true});f.message('one','正在播放');f.speech.tick();while(!release)await flush();
 f.message('two','普通建议');f.speech.tick();f.message('three','紧急建议',2);f.speech.tick();assert.equal(firstSignal.aborted,false);
 release();await f.speech.settle();assert.deepEqual(order,['正在播放']);assert.equal(f.speech.status().queueDepth,0);
});

test('role changes discard delayed synthesis and persist settings without replaying old advice',async t=>{
 let release;const f=await fixture(t,{synthesize:async()=>new Promise(r=>release=r)});
 await f.speech.configure({enabled:true});f.message('one','旧角色');f.speech.tick();while(!release)await flush();
 await f.speech.configure({role:'tiezhi'});release({text:'旧角色'});await f.speech.settle();assert.equal(f.played.length,0);
 const saved=JSON.parse(await readFile(join(f.stateDir,'speech-settings.json')));assert.equal(saved.role,'tiezhi');assert.equal(saved.enabled,true);
});

test('turning off chat reading preserves current battle audio and removes pending chat',async t=>{
 let release,signal;const played=[];
 const f=await fixture(t,{play:async(audio,s)=>{played.push(audio.text);if(played.length===1){signal=s;await new Promise(r=>release=r);}}});
 await f.speech.configure({enabled:true});f.message('one','当前战况');f.speech.tick();while(!release)await flush();
 f.message('two','后续战况');f.speech.tick();f.speech.chat({game:'lol',match:'one',text:'待播聊天'});
 await f.speech.configure({chat:false});assert.equal(signal.aborted,false);assert.equal(f.speech.status().state,'playing');
 release();await f.speech.settle();assert.deepEqual(played,['当前战况']);
});

test('match change, revocation, expiration and disabling speech cancel stale work',async t=>{
 let release,signal;const f=await fixture(t,{synthesize:async(_text,_role,s)=>{signal=s;return new Promise(r=>release=r);}});
 await f.speech.configure({enabled:true});f.message('one','旧局');f.speech.tick();while(!release)await flush();
 f.view.match='two';f.view.playback=[];f.speech.tick();assert.equal(signal.aborted,true);release({text:'旧局'});await f.speech.settle();assert.equal(f.played.length,0);
 f.message('expired','过期');f.advance(46000);f.speech.tick();await f.speech.settle();assert.equal(f.played.length,0);
});

test('provider failures expose safe status, never fall back to a different voice, and do not break chat',async t=>{
 const f=await fixture(t,{synthesize:async()=>{throw Object.assign(Error('Bearer private'),{code:'speech_login_required'});}});
 await f.speech.configure({enabled:true});assert.equal(f.speech.chat({game:'lol',match:'one',text:'回答'}),true);await f.speech.settle();
 assert.equal(f.speech.status().lastCode,'speech_login_required');assert.equal(f.played.length,0);assert.ok(!JSON.stringify(f.trace).includes('private'));
});

test('capture pause and explicit revocation cancel advice without silencing manual chat',async t=>{
 let release,signal;const f=await fixture(t,{synthesize:async(_text,_role,s)=>{signal=s;return new Promise(r=>release=r);}});
 await f.speech.configure({enabled:true});f.message('one','旧建议');f.speech.tick();while(!release)await flush();
 f.view.phase='CapturePaused';f.view.revokedPlayback=['one'];f.speech.tick();assert.equal(signal.aborted,true);release({text:'旧建议'});await f.speech.settle();assert.equal(f.played.length,0);
 assert.equal(f.speech.chat({game:'lol',match:'one',text:'手动回答'}),true);while(!release)await flush();release({text:'手动回答'});await f.speech.settle();assert.equal(f.played.at(-1),'手动回答');
});

test('speech HTTP settings protect keys, support role preview and expose the deep-linked settings page',async t=>{
 const f=await fixture(t),values=new Map(),credentials={resolve:async k=>values.has(k)?{value:values.get(k)}:undefined,set:async(k,v)=>values.set(k,v),unset:async k=>values.delete(k)};
 const setup=await createSetupServer({stateDir:f.stateDir,port:0,credentials,speech:f.speech,runtimeId:'standalone',fetchImpl:async()=>Response.json({})});t.after(()=>setup.close());
 const [base,nonce]=setup.url.split('/#'),headers={'x-jinbao-setup':nonce,'Content-Type':'application/json'};
 assert.equal((await fetch(base+'/api/speech')).status,403);
 let response=await fetch(base+'/api/speech',{method:'POST',headers,body:JSON.stringify({role:'liurufeng',source:'byok',apiKey:'private-voice-key'})});assert.equal(response.status,200);
 const value=await response.json();assert.equal(value.keyConfigured,true);assert.ok(!JSON.stringify(value).includes('private-voice-key'));
 assert.equal(values.get('JINBAO_USER_SPEECH_API_KEY'),'private-voice-key');
 assert.equal((await fetch(base+'/api/speech/preview',{method:'POST',headers,body:'{}'})).status,200);await f.speech.settle();assert.equal(f.played.at(-1),roles[1].intro);
 assert.equal((await fetch(base+'/?page=voice')).status,200);
 response=await fetch(base+'/api/speech',{method:'POST',headers,body:JSON.stringify({role:'invalid'})});assert.equal(response.status,400);
});

test('official speech uses the authenticated fixed endpoint and validates audio before playback',async()=>{
 let path,body;const wav=Buffer.alloc(444);wav.write('RIFF');wav.write('WAVE',8);
 const synth=cloudSpeech({getToken:async()=> 'private-token',fetchImpl:async(url,options)=>{path=new URL(url).pathname;body=JSON.parse(options.body);assert.match(options.headers.Authorization,/Bearer/);return Response.json({mediaType:'audio/wav',audioBase64:wav.toString('base64')});}});
 const result=await synth('试音','tiezhi',new AbortController().signal);assert.equal(path,'/desktop/agent-preview/speech');assert.deepEqual(body,{text:'试音',role:'tiezhi'});assert.equal(result.mediaType,'audio/wav');
 const missing=ownSpeech({getKey:async()=>''});await assert.rejects(missing('试音','jinbao',new AbortController().signal),e=>e.code==='speech_key_required');
});

test('native BYOK synthesis compiles without network requests or audible playback',{skip:process.platform!=='win32'},()=>{
 const stdout=execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',new URL('../synthesize-speech.ps1',import.meta.url).pathname.replace(/^\/(.:)/,'$1'),'-CheckOnly'],{encoding:'utf8',windowsHide:true});assert.equal(JSON.parse(stdout).compiled,true);
});

test('changing role during real silent playback closes the previous child before starting another',{skip:process.platform!=='win32'},async t=>{
 const wav=Buffer.alloc(44+88200);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(22050,24);wav.writeUInt32LE(44100,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
 const pids=[];let overlap=false;
 const f=await fixture(t,{synthesize:async()=>({audioBase64:wav.toString('base64')}),play:(audio,signal)=>runSpeechProcess(fileURLToPath(new URL('../audio-player.ps1',import.meta.url)),audio,{signal,onSpawn:pid=>{for(const old of pids)try{process.kill(old,0);overlap=true;}catch{}pids.push(pid);}})});
 await f.speech.configure({enabled:true});f.message('old','旧角色声音');f.speech.tick();
 for(let i=0;pids.length===0&&i<100;i++)await new Promise(r=>setTimeout(r,10));assert.equal(pids.length,1);
 await new Promise(r=>setTimeout(r,800));await f.speech.configure({role:'liurufeng'});
 f.speech.preview();await f.speech.settle();
 assert.equal(pids.length,2);assert.equal(overlap,false);for(const pid of pids)assert.throws(()=>process.kill(pid,0));
});

test('normal speech waits 45 seconds; only the latest manual message may wait and expires after 20 seconds',async t=>{
 const f=await fixture(t,{minIntervalMs:45000});await f.speech.configure({enabled:true});
 f.message('one','第一条建议。');f.speech.tick();await f.speech.settle();assert.equal(f.calls.length,1);
 f.advance(1000);f.message('two','不应排队的自动建议。',2);f.speech.tick();
 f.speech.chat({game:'lol',match:'one',text:'旧聊天。'});f.speech.chat({game:'lol',match:'one',text:'新聊天。'});
 assert.equal(f.speech.status().queueDepth,1);await f.speech.settle();assert.equal(f.calls.length,1);
 f.advance(21000);f.speech.tick();await f.speech.settle();assert.equal(f.speech.status().queueDepth,0);assert.equal(f.calls.length,1);
 f.advance(23000);f.message('three','现在这条才可播。');f.speech.tick();await f.speech.settle();assert.equal(f.calls.length,2);
});

test('long text is never sent for speech synthesis or summarized by another model request',async t=>{
 const f=await fixture(t);await f.speech.configure({enabled:true});
 assert.equal(f.speech.chat({game:'lol',match:'one',text:'长'.repeat(200)}),false);await f.speech.settle();assert.equal(f.calls.length,0);
 const original='很长的背景'.repeat(30)+'。先等队友控制，再接大招。';f.message('short',original);f.speech.tick();await f.speech.settle();
 assert.equal(f.calls.length,1);assert.ok(f.calls[0].text.length<=60);assert.equal(f.view.playback[0].text,original);
});

test('a pending manual answer is replaced by the latest before the next quiet slot opens',async t=>{
 const f=await fixture(t,{minIntervalMs:45000});await f.speech.configure({enabled:true});
 f.message('one','自动建议。');f.speech.tick();await f.speech.settle();
 f.advance(35000);f.speech.chat({game:'lol',match:'one',text:'旧聊天。'});f.speech.chat({game:'lol',match:'one',text:'新聊天。'});await f.speech.settle();assert.equal(f.calls.length,1);
 f.advance(10000);f.speech.tick();await f.speech.settle();assert.deepEqual(f.played,['自动建议。','新聊天。']);
});
