import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initialOverlayState,overlayView} from '../overlay-state.mjs';
import {createAgentStatus} from '../../dsh-coach-server/lib/agent-status.js';
import {chatFailureMessage} from '../chat-errors.mjs';

const FAILED='模型请求失败，等待恢复；可在设置查看诊断';

test('agent status persists the phase so a failed round can be told apart from progress',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'jinbao-agent-status-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await createAgentStatus(dir,'lol','match-one')('error');
  const saved=JSON.parse(await readFile(join(dir,'agent-status.json'),'utf8'));
  assert.equal(saved.phase,'error');
  assert.equal(saved.label,FAILED);
  assert.equal(saved.game,'lol');
  assert.equal(saved.match,'match-one');
});

test('a failed round is shown in the advice line instead of looking idle',()=>{
  const failed=initialOverlayState();
  Object.assign(failed,{game:'lol',match:'match-one',at:Date.now(),agentError:FAILED});
  assert.match(overlayView(failed).advice,new RegExp(FAILED));

  const idle=initialOverlayState();
  Object.assign(idle,{game:'lol',match:'match-one',at:Date.now()});
  assert.match(overlayView(idle).advice,/等待进入游戏/);
  assert.doesNotMatch(overlayView(idle).advice,new RegExp(FAILED));
});

test('a new match never inherits the previous failure state',()=>{
  const state=initialOverlayState();
  assert.equal(state.agentError,'');
  assert.equal(state.agentStatus,'');
  assert.equal(state.coachStatus,null);
});

test('429 rate limiting is worded differently from an exhausted quota',()=>{
  assert.match(chatFailureMessage({status:429,code:'rate_limited'}),/过于频繁/);
  assert.match(chatFailureMessage({status:429,code:'model_quota_denied'}),/额度不足/);
  assert.match(chatFailureMessage({status:429}),/额度不足/);
  assert.match(chatFailureMessage({status:401}),/重新登录/);
});
