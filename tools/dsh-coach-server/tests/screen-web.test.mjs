import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createScreenInspector} from '../lib/screen-tool.js';
import {cacheSearchProvider,gameSearchQuery,decodeWebBytes,relevantGameSource} from '../lib/game-web.js';
test('screen tool transports real inline image through authenticated local route and keeps observation separate from confirmed facts',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jinbao-screen-'));let state={game:'lol',match:'one',updatedAt:Date.now(),ended:false};
 const save=()=>writeFile(join(dir,'overlay-state.json'),JSON.stringify(state));await save();await writeFile(join(dir,'settings-link.txt'),'http://127.0.0.1:3084/#test');let calls=0;
 const inspect=createScreenInspector({stateDir:dir,game:'lol',match:'one',getToken:async()=>'local-only',capture:async()=>({available:true,game:'lol',mediaType:'image/jpeg',capturedAt:Date.now(),data:Buffer.from('fake fixture bytes').toString('base64')}),fetchImpl:async(url,options)=>{
  calls++;assert.equal(url,'http://127.0.0.1:3084/v1/chat/completions');assert.equal(options.headers.Authorization,'Bearer local-only');
  assert.match(JSON.parse(options.body).messages[1].content[1].image_url.url,/^data:image\/jpeg;base64,/);
  return Response.json({choices:[{message:{content:JSON.stringify({observations:'可见三个候选，无法判断已选',uncertain:['未看到确认结果']})}}]});
 }});
 const result=await inspect({question:'看候选'});assert.equal(result.status,'observed');assert.match(result.note,/未写入/);
 assert.equal((await inspect({question:'看候选'})).reused,true);assert.equal(calls,1);
 state.match='other';await save();assert.equal((await inspect()).reason,'no_current_match');assert.equal(calls,1);
});
test('screen capture failure or changing match never produces a fabricated observation or sends an image',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jinbao-no-screen-'));const state={game:'lol',match:'one',updatedAt:Date.now()};await writeFile(join(dir,'overlay-state.json'),JSON.stringify(state));let calls=0;
 const inspect=createScreenInspector({stateDir:dir,game:'lol',match:'one',getToken:async()=>'',capture:async()=>({available:false,reason:'game_not_visible'}),fetchImpl:async()=>{calls++;throw Error('unexpected network');}});
 assert.equal((await inspect()).status,'unavailable');assert.equal(calls,0);
 const changed=createScreenInspector({stateDir:dir,game:'lol',match:'one',capture:async()=>{await writeFile(join(dir,'overlay-state.json'),JSON.stringify({...state,match:'two'}));return {available:true,game:'lol',capturedAt:Date.now(),data:'',mediaType:'image/jpeg'};},getToken:async()=>'',fetchImpl:async()=>{calls++;}});
 assert.equal((await changed()).reason,'stale_or_changed_match');assert.equal(calls,0);
});
test('Mayhem search constraints survive caching; concurrent searches deduplicate and cache values cannot be poisoned by the caller',async()=>{
 let calls=0;const provider=cacheSearchProvider({id:'test',available:()=>true,search:async request=>{calls++;await new Promise(r=>setTimeout(r,10));return {sources:[{title:request.query,url:'https://example.com'}]};}},{readState:()=>({game:'lol',mode:'KIWI'})});
 const [a,b]=await Promise.all([provider.search({query:'英雄联盟 安妮 出装'}),provider.search({query:'英雄联盟 安妮 出装'})]);assert.equal(calls,1);assert.match(a.sources[0].title,/海克斯大乱斗/);a.sources[0].title='poison';assert.notEqual((await provider.search({query:'英雄联盟 安妮 出装'})).sources[0].title,'poison');assert.notEqual(b.sources[0].title,'poison');
 assert.equal(gameSearchQuery('王者荣耀出装',{game:'lol',mode:'KIWI'}),'王者荣耀出装');
 assert.equal(gameSearchQuery('英雄联盟经典模式出装',{game:'lol',mode:'KIWI'}),'英雄联盟经典模式出装');
 assert.match(gameSearchQuery('League of Legends Annie official',{game:'lol',mode:'KIWI'}),/ARAM Mayhem/);
 assert.equal(relevantGameSource({url:'https://www.iciba.com/word?w=league',title:'league词典'},'League of Legends Annie'),false);
 assert.equal(relevantGameSource({url:'https://baike.baidu.com/item/league',title:'league英文单词'},'League of Legends Annie'),false);
 assert.equal(relevantGameSource({url:'https://www.leagueoflegends.com/en-us/',title:'League of Legends'},'ARAM Mayhem'),true);
});
test('Chinese HTML without HTTP charset decodes meta GBK correctly, and corrupted text is rejected',()=>{
 const bytes=Buffer.concat([Buffer.from('<meta charset="gbk"><p>'),Buffer.from('d6d0b9fa','hex'),Buffer.from('</p>')]);assert.match(decodeWebBytes(bytes,'text/html'),/中国/);assert.match(decodeWebBytes(bytes,'text/html;charset=utf-8'),/中国/);
 assert.throws(()=>decodeWebBytes(Buffer.alloc(30,255),'text/html'),/编码/);
});
