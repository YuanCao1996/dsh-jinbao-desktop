import test from 'node:test';
import assert from 'node:assert/strict';
import {localTurnText} from '../local-agent.mjs';
import {roleInstruction} from '../../shared/game-roles.mjs';

const request=(overrides={})=>({game:'lol',match:'m1',topic:'advice',question:'现在该做什么',...overrides});

test('the BYOK turn carries the selected mentor tone, exactly like the cloud route',()=>{
  for(const role of ['jinbao','liurufeng','wangbatian','tiezhi']){
    const text=localTurnText(request({role}),'规则一。');
    assert.match(text,new RegExp(roleInstruction(role,'lol').replace(/[.*+?^${}()|[\]\\]/g,'\\$&').slice(0,12)));
    assert.ok(text.includes('规则一。'),'game rules must survive');
    assert.ok(text.includes('现在该做什么'),'the question must survive');
  }
});

test('different mentors produce different turn text',()=>{
  const a=localTurnText(request({role:'jinbao'}),'规则。');
  const b=localTurnText(request({role:'wangbatian'}),'规则。');
  assert.notEqual(a,b);
});

test('an unknown or missing role adds nothing rather than inventing a persona',()=>{
  const plain=localTurnText(request({role:undefined}),'规则。');
  assert.equal(plain,'规则。\n现在该做什么\n请先按需使用工具。当前游戏：lol；会话仅属于本局。');
  assert.equal(localTurnText(request({role:'nobody'}),'规则。'),plain);
});

test('automatic broadcasts keep the same mentor and get the auto-task stance',()=>{
  const manual=localTurnText(request({role:'tiezhi',automatic:false}),'规则。');
  const automatic=localTurnText(request({role:'tiezhi',automatic:true}),'规则。');
  assert.match(manual,/幽默解说/);
  assert.match(automatic,/自动任务改为同主题的事实解说与走势分析/);
  assert.notEqual(manual,automatic);
  // The mentor still applies to auto tasks rather than being dropped there.
  assert.match(automatic,/当前角色：铁汁/);
});
