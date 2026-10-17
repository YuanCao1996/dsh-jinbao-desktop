import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gameModePrompt} from '../lib/game-mode-prompt.js';
import {buildGameChatMessage} from '../lib/chat-bridge.js';
import {LOL_ADAPTER} from '../lib/adapters/lol.js';
import {createGameMemory} from '../lib/game-memory.js';
import {initialOverlayState,applyOverlayEvent} from '../../dsh-onboarding/overlay-state.mjs';

test('chat receives Mayhem constraints even before any automatic coaching, and corrects prior classic advice',()=>{
  const prompt=buildGameChatMessage('怎么出装？',{current:{game:'lol',mode:'KIWI'}});
  assert.match(prompt,/当前玩法：LoL 海克斯大乱斗/);
  for(const rule of ['单线推进','不推荐常规符文页','单槽刷新','不等于已选','ARAM Mayhem','应纠正而非延续'])assert.ok(prompt.includes(rule),rule);
  assert.match(prompt,/不要推荐上下路分带、打野路线、插眼控龙/);
});

test('ordinary ARAM, classic and unknown modes are not falsely asserted as confirmed Mayhem; WZRY is independent',()=>{
  assert.match(gameModePrompt({game:'lol',mode:'ARAM'}),/当前玩法：普通极地大乱斗/);
  assert.match(gameModePrompt({game:'lol',mode:'CLASSIC'}),/不能宣称本局是海克斯大乱斗/);
  assert.match(gameModePrompt({game:'lol'}),/日志尚未确认模式/);
  assert.match(gameModePrompt({game:'wzry'}),/当前游戏为王者荣耀/);
  assert.doesNotMatch(gameModePrompt({game:'wzry'}),/当前玩法：LoL/);
});

test('automatic and chat prompts share the mode rules, and event batches stop labeling every mode as Mayhem',()=>{
  const event=LOL_ADAPTER.log.classify({kind:'game_start',game:'lol',queue:'KIWI',me:{champion:'安妮'}});
  const body=LOL_ADAPTER.prompt.eventsToBody([event]);
  assert.equal(body.mode,'KIWI');assert.match(body.system_prompt,/单槽刷新/);
  const classic=LOL_ADAPTER.prompt.eventsToBody([{...event,queue:'CLASSIC'}]);
  assert.equal(classic.mode,'CLASSIC');assert.doesNotMatch(classic.prompt,/实时对局观察\(海克斯大乱斗/);
  assert.match(classic.system_prompt,/不能假定存在海克斯强化/);
});

test('collector mode survives shared state, persistent memory, restart and context reduction; next match clears it',async()=>{
  const state=initialOverlayState();
  applyOverlayEvent(state,{game:'lol',kind:'game_start',queue:'KIWI',t:1},'one');
  applyOverlayEvent(state,{game:'lol',kind:'state',state:{time:10},t:2},'one');
  assert.equal(state.mode,'KIWI');
  const dir=await mkdtemp(join(tmpdir(),'jinbao-game-mode-'));
  await createGameMemory(dir).snapshot({...state,broadcasts:Array.from({length:100},()=>({text:'资料'.repeat(4000)}))});
  const context=await createGameMemory(dir).context('lol','one');assert.equal(context.current.mode,'KIWI');
  applyOverlayEvent(state,{game:'lol',kind:'game_start',queue:'ARAM',t:3},'two');assert.equal(state.mode,'ARAM');
  applyOverlayEvent(state,{game:'wzry',kind:'game_start',t:4},'three');assert.equal(state.mode,'');
});
