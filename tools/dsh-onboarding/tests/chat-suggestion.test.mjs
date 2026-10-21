import test from 'node:test';
import assert from 'node:assert/strict';
import {suggestOverlayQuestion} from '../chat-suggestion.mjs';
import {createOverlayService} from '../overlay-state.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('suggested follow-up uses confirmed match facts and avoids inventing absent choices', () => {
  assert.equal(suggestOverlayQuestion({game:'lol',phase:'ChampSelect',me:{}}), '当前可选英雄里，哪个更适合海克斯大乱斗？');
  assert.match(suggestOverlayQuestion({game:'lol',me:{champion:'安妮'},offers:[{name:'珠光护手'}]}), /海克斯.*安妮/);
  assert.match(suggestOverlayQuestion({game:'lol',me:{champion:'安妮'},enemies:[{items:[{name:'无尽之刃'}]}]}), /敌方装备/);
  assert.match(suggestOverlayQuestion({game:'wzry',me:{champion:'后羿'}}), /后羿/);
  assert.equal(suggestOverlayQuestion({game:'lol',ended:true,me:{champion:'安妮'}}), '');
  assert.equal(suggestOverlayQuestion({game:'unknown',me:{}}), '');
});

test('desktop conversation can scroll forty recent messages and persists a bounded longer history', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'jinbao-chat-parity-'));
  t.after(() => rm(stateDir, {recursive:true,force:true}));
  const service = await createOverlayService({stateDir,pollMs:100000,agentChat:async ({question}) => `回答${question}`});
  t.after(() => service.close());
  for(let i=0;i<26;i++) await service.ask(`问题${i}`);
  const view=service.view();
  assert.equal(view.chatRows.length,40);
  assert.equal(view.chatRows[0].text,'问题6');
  assert.equal(view.chatRows.at(-1).text,'回答问题25');
});
