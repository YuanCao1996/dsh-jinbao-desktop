import test from 'node:test';
import assert from 'node:assert/strict';
import { roomTaskStatus, roomProgressStatus } from '../client.mjs';

test('shared task feedback shows the mentor and prioritizes active work over old failures', () => {
  const room = { mentorRole: 'liurufeng', mentorRoles: [{ id: 'liurufeng', name: '柳如风' }] };
  assert.equal(roomTaskStatus({ room, tasks: [{ status: 'failed', createdAt: 1000 }, { status: 'running' }] }, 2000), '柳如风正在处理队伍问题…');
  assert.match(roomTaskStatus({ tasks: [{ status: 'queued' }] }), /排队中.*普通聊天/);
});

test('failed, cancelled and reconciled task feedback never exposes upstream errors or implies an automatic retry', () => {
  const state = (status, error, automatic = false) => ({ tasks: [{ status, error, automatic, createdAt: 1000 }] });
  assert.match(roomTaskStatus(state('failed', 'secret-provider-url-token'), 2000), /未生成有效回答/);
  assert.doesNotMatch(roomTaskStatus(state('failed', 'secret-provider-url-token'), 2000), /secret|provider|token/);
  assert.match(roomTaskStatus(state('cancelled', 'evidence_changed'), 2000), /信息已变化.*旧回答未发布/);
  assert.match(roomTaskStatus(state('cancelled', 'membership_changed', true), 2000), /^这条主动建议/);
  assert.match(roomTaskStatus(state('failed', 'usage_reconciliation_pending'), 2000), /用量待核对.*不会自动重试/);
  assert.match(roomTaskStatus(state('failed', 'reconciled_without_reply'), 2000), /用量已核对.*未补发/);
});

test('old terminal feedback expires, completed work clears old failures and held budget remains visible', () => {
  const failure = { status: 'failed', createdAt: 1000 };
  assert.equal(roomTaskStatus({ tasks: [failure] }, 301001), '');
  assert.equal(roomTaskStatus({ tasks: [failure, { status: 'completed', createdAt: 2000 }] }, 3000), '');
  assert.match(roomTaskStatus({ tasks: [failure], budget: { pendingReconciliations: 1 } }, 400000), /用量待核对.*普通聊天/);
  assert.equal(roomTaskStatus({ tasks: [{ ...failure, createdAt: 999999 }] }, 1000), '');
  assert.equal(roomTaskStatus({}), '');
});

test('connection and confirmation notices cannot mask task progress, while authentication errors take priority', () => {
  const state = { tasks: [{ status: 'queued' }], notice: '已连接，两端共用一个队伍成员。' };
  assert.match(roomProgressStatus(state), /^队伍问题排队中.*\n已连接/);
  state.tasks = [{ status: 'failed', error: 'agent_failed', createdAt: 1000 }];
  assert.match(roomProgressStatus(state, 2000), /^本次提问未完成.*\n已连接/);
  state.notice = '两端记录的选择不一致，请核对实际选择。';
  assert.match(roomProgressStatus(state, 2000), /未完成.*\n两端记录/);
  state.error = '请先重新登录'; assert.equal(roomProgressStatus(state, 2000), state.error);
});
