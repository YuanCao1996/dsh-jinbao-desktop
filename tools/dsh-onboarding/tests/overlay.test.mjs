import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialOverlayState, applyOverlayEvent, overlayView, clock, createOverlayService } from '../overlay-state.mjs';
import { stateEvent, createRosterStats } from '../../lol-companion/collector-state.mjs';
import { createSetupServer } from '../server.mjs';

test('win rate page uses hero sample rates and tiers, ignores player history, and omits counts',()=>{
 const s=initialOverlayState();s.game='lol';s.me.champion='安妮';
 s.allies=[{champion:'锐雯',puuid:'a',riotId:'隐藏名字A#123'}];
 s.enemies=[{champion:'安妮',puuid:'b'},{champion:'布隆',puuid:'c'},{champion:'娜美',puuid:'d'}];
 s.playerStats=[{puuid:'a',winRate:99,games:20},{puuid:'b',winRate:1,games:20},{puuid:'c',winRate:100,games:20}];
 const v=overlayView(s,{rows:[{_viewKind:'hero',name:'安妮',winRate:55.21,tier:0},{_viewKind:'hero',name:'锐雯',winRate:50,tier:'T1'},{_viewKind:'hero',name:'娜美',winRate:0,tier:3},{_type:'augments',champion:'布隆',winRate:80,tier:'T1'}]});
 assert.deepEqual(v.playerRows.map(r=>r.champion),['安妮','锐雯','娜美','布隆']);
 assert.deepEqual(v.playerRows.map(r=>r.winRate),[55.21,50,0,null]);
 assert.deepEqual(v.playerRows.map(r=>r.tierText),['T0','T1','T3','暂无']);
 assert.doesNotMatch(JSON.stringify({players:v.players,rows:v.playerRows,stats:v.stats}),/隐藏|puuid|riotId|gamesText|kda|场次|近期胜率|99%|100%/);
 assert.match(v.players,/双方英雄胜率/);assert.match(v.players,/55.21%/);
});

test('mid-game capture uses elapsed seconds, ends at GameEnd, resets across matches and does not invent win rates',()=>{
 const s=initialOverlayState();
 applyOverlayEvent(s,{game:'lol',t:1000,kind:'game_start',me:{champion:'放逐之刃'}},'match1');
 applyOverlayEvent(s,{game:'lol',t:1001,kind:'state',state:{time:119,items:[{name:'星蚀'}],gold:502}},'match1');
 applyOverlayEvent(s,{at:1002,game:'lol',broadcast:'保持站位'},'coach');
 const v=overlayView(s,{rows:[{name:'锐雯',title:'放逐之刃',_viewKind:'hero',winRate:47.3},{champion:'放逐之刃 锐雯',_type:'coreBuilds',items:'["星蚀","焚天"]',winRate:48.9},{champion:'放逐之刃 锐雯',_type:'augments',name:'全凭身法',winRate:49.85,desc:'冲刺技能急速'}]});
 assert.equal(v.gameTime,'01:59');assert.equal(v.advice,'保持站位');
 assert.match(v.equipment,/星蚀、焚天/);assert.match(v.augments,/全凭身法/);assert.match(v.stats,/47.3%/);assert.doesNotMatch(v.stats,/48.9%/);
 assert.doesNotMatch(v.stats,/玩家战绩|场次/);assert.doesNotMatch(v.players,/0%/);
 applyOverlayEvent(s,{game:'lol',t:2000,kind:'event',name:'GameEnd',time:559},'match1');
 applyOverlayEvent(s,{game:'lol',t:2001,kind:'state',state:{time:560}},'match1');
 assert.equal(overlayView(s).gameTime,'09:20');assert.equal(s.ended,true);
 s.chat.push({role:'user',text:'上一局问题'});
 applyOverlayEvent(s,{game:'lol',t:3000,kind:'game_start',gameTime:3,me:{champion:'安妮'}},'match2');
 applyOverlayEvent(s,{at:1002,broadcast:'上一局建议'},'coach');
 assert.equal(s.ended,false);assert.equal(s.events.length,0);assert.equal(s.broadcasts.length,0);assert.equal(overlayView(s).gameTime,'00:03');
 assert.equal(s.chat.length,0);
 assert.equal(clock(3601),'60:01');assert.equal(clock(null),'等待对局');
});

test('a delayed chat reply cannot overwrite the next match or its advice',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jinbao-chat-race-'));await mkdir(join(dir,'logs'));
 const file=join(dir,'logs','lol-live.jsonl');
 await writeFile(file,JSON.stringify({game:'lol',t:1,kind:'game_start',gameTime:5})+'\n');
 let finish;
 const service=await createOverlayService({stateDir:dir,pollMs:10,agentChat:()=>new Promise(resolve=>{finish=resolve;}),search:()=>{throw Error('unexpected query')}});t.after(service.close);
 const request=service.ask('上一局怎么出装','equipment');
 const rejected=assert.rejects(request,error=>error.status===409);
 for(let i=0;!finish&&i<100;i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(typeof finish,'function');
 await appendFile(file,JSON.stringify({game:'lol',t:2,kind:'game_start',gameTime:0})+'\n');
 for(let i=0;service.view().gameTime!=='00:00'&&i<100;i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(service.view().gameTime,'00:00');
 finish('上一局的过期出装建议');await rejected;
 assert.doesNotMatch(service.view().chat,/上一局/);
 assert.doesNotMatch(service.view().equipment,/过期出装建议/);
});

test('collector preserves both teams and resolves missing puuid through tagged player name before reading history',async()=>{
 const compact={gameTime:119,mode:'KIWI',me:{riotId:'玩家#123',hp:100,maxHp:200},allies:[{champion:'锐雯',riotId:'玩家#123',k:1}],enemies:[{champion:'安妮',puuid:'enemy',items:[{name:'帽子'}],k:2}]};
 const e=stateEvent(compact);assert.equal(e.state.time,119);assert.equal(e.allies.length,1);assert.equal(e.enemies.length,1);assert.equal(e.state.enemyKills,2);
 const calls=[];
 const lookup=createRosterStats(()=>({ok:true}),async(_c,path)=>{
  calls.push(path);if(path.startsWith('/lol-summoner'))return {status:200,data:{puuid:'mine'}};
  return {status:200,data:{games:{games:[{queueId:2400,gameMode:'KIWI',participantIdentities:[{participantId:1,player:{}}],participants:[{participantId:1,stats:{win:true,kills:2,deaths:1,assists:3}}]}]}}};
 });
 const stats=await lookup(compact);assert.equal(stats.rows.length,2);assert.equal(stats.rows[0].winRate,100);assert.equal(stats.rows[0].team,'me');
 assert.ok(calls.some(path=>path.includes(encodeURIComponent('玩家#123'))));assert.ok(calls.some(path=>path.includes('/mine/matches')));
});

test('chat uses authenticated native Agent bridge in both BYOK and cloud modes; knowledge remains independently authenticated',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jinbao-overlay-'));await mkdir(join(dir,'logs'));
 const now=Date.now();await writeFile(join(dir,'logs','lol-live.jsonl'),JSON.stringify({game:'lol',t:now,kind:'state',me:{champion:'锐雯'},state:{time:119}})+'\n');
 const values=new Map([['JINBAO_SERVICE_TOKEN','cloud-token'],['JINBAO_USER_MODEL_API_KEY','private-model-key']]);
 await writeFile(join(dir,'settings.json'),JSON.stringify({mode:'byok',baseUrl:'https://vendor.test/v1',model:'my-model'}));
 const calls=[];const credentials={resolve:async k=>values.has(k)?{value:values.get(k)}:undefined,set:async(k,v)=>values.set(k,v)};
 const setup=await createSetupServer({stateDir:dir,port:0,credentials,fetchImpl:async(url,opts)=>{
  calls.push({url:String(url),opts});
  if(new URL(url).pathname==='/coach/chat')return Response.json({answer:'等队友先手再进场'});
  if(new URL(url).pathname==='/site/search')return Response.json({results:[{data:{champion:'锐雯',_type:JSON.parse(opts.body).filter?._type,name:'全凭身法',items:'["星蚀"]',winRate:50}}]});
  return Response.json({choices:[{message:{content:'等队友先手再进场'}}]});
 }});t.after(setup.close);
 const base=setup.url.split('/#')[0],nonce=setup.url.split('#')[1];
 assert.equal((await fetch(base+'/api/overlay/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"question":"怎么打"}'})).status,403);
 const headers={'x-jinbao-setup':nonce,'Content-Type':'application/json'};
 const answer=await fetch(base+'/api/overlay/ask',{method:'POST',headers,body:JSON.stringify({question:'怎么打团',topic:'teamfight'})});assert.equal(answer.status,200);
 const call=calls.find(c=>c.url==='http://127.0.0.1:3081/coach/chat');assert.equal(call.opts.headers.Authorization,'Bearer '+values.get('JINBAO_LOCAL_ACCESS_KEY'));
 assert.equal(JSON.parse(call.opts.body).question,'怎么打团');assert.ok(JSON.parse(call.opts.body).match);
 assert.equal(calls.some(c=>c.url==='https://vendor.test/v1/chat/completions'),false);
 const view=await(await fetch(base+'/api/overlay',{headers})).json();assert.equal(view.gameTime,'01:59');assert.match(view.chat,/怎么打团/);assert.equal(view.teamfight,'等队友先手再进场');
 assert.ok(!JSON.stringify(view).includes('private-model-key'));assert.ok(!JSON.stringify(view).includes('cloud-token'));
 const modelRequest=JSON.stringify(call.opts.body);assert.ok(!modelRequest.includes('private-model-key'));assert.ok(!modelRequest.includes('cloud-token'));
 await fetch(base+'/api/model',{method:'POST',headers,body:JSON.stringify({mode:'cloud'})});
 const cloudAnswer=await fetch(base+'/api/overlay/ask',{method:'POST',headers,body:JSON.stringify({question:'下一步出装呢？'})});assert.equal(cloudAnswer.status,200);
 assert.equal(calls.filter(c=>c.url==='http://127.0.0.1:3081/coach/chat').length,2);
 assert.equal(calls.some(c=>c.url==='https://api.jinbaoai.top/v1/chat/completions'),false);
});

test('offline logs populate all factual pages without model traffic; split UTF8 is read once complete',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jinbao-offline-'));await mkdir(join(dir,'logs'));
 const file=join(dir,'logs','lol-live.jsonl');const state={game:'lol',t:1,kind:'state',state:{time:560,items:[{name:'星蚀'}]}};
 await writeFile(file,JSON.stringify(state)+'\n');
 const service=await createOverlayService({stateDir:dir,pollMs:20,complete:()=>{throw Error('unexpected model call')},search:()=>{throw Error('unexpected query')}});t.after(service.close);
 const bytes=Buffer.from(JSON.stringify({game:'lol',t:2,kind:'state',state:{time:561,items:[{name:'焚天'}]}})+'\n');
 const index=bytes.indexOf(Buffer.from('焚天'))+1;
 await appendFile(file,bytes.subarray(0,index));await new Promise(r=>setTimeout(r,60));assert.equal(service.view().gameTime,'09:20');
 await appendFile(file,bytes.subarray(index));await new Promise(r=>setTimeout(r,80));assert.equal(service.view().gameTime,'09:21');assert.match(service.view().equipment,/焚天/);
 assert.equal(JSON.parse(await readFile(join(dir,'overlay-state.json'),'utf8')).gameTime,'09:21');
});
