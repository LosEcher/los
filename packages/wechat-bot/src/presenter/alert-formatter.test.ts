import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  alertRequiresDecision,
  alertTitle,
  buildAlertMessage,
  type OperatorAlert,
} from './alert-formatter.js';

function alert(overrides: Partial<OperatorAlert>): OperatorAlert {
  return {
    sessionId: 'session-test',
    type: 'tool.warned',
    severity: 'warning',
    toolName: 'list_directory',
    reason: '该路径被标记为脆弱路径',
    ...overrides,
  };
}

const options = { targetChannel: 'weixin' as const, gatewayUrl: 'http://localhost:4100' };

describe('alert-formatter', () => {
  it('renders tool.warned as an informational notice without approve/deny actions', () => {
    const message = buildAlertMessage(alert({ kind: 'info', title: '风险提示｜任务已继续（无需回复）' }), options);
    assert.match(message.text, /风险提示｜任务已继续（无需回复）/);
    assert.match(message.text, /任务已继续执行，本条无需回复/);
    assert.deepEqual(message.actions!.map(a => a.value), ['status']);
  });

  it('renders tool.denied as already_denied without approve/deny actions', () => {
    const message = buildAlertMessage(alert({
      type: 'tool.denied',
      kind: 'already_denied',
      title: '工具已拒绝',
      severity: 'info',
    }), options);
    assert.match(message.text, /工具已拒绝/);
    assert.match(message.text, /策略已自动拒绝/);
    assert.deepEqual(message.actions!.map(a => a.value), ['status']);
  });

  it('renders persisted approval requests with approve/deny actions', () => {
    const message = buildAlertMessage(alert({
      type: 'operator_attention',
      kind: 'needs_decision',
      title: '等待你审批',
      severity: 'critical',
      runSpecId: 'run-approval-1',
    }), options);
    assert.match(message.text, /等待你审批/);
    assert.deepEqual(message.actions!.map(a => a.value), ['approve', 'deny', 'escalate']);
  });

  it('derives titles from kind when no explicit title is set', () => {
    assert.equal(alertTitle(alert({ kind: 'info' })), '风险提示，任务继续');
    assert.equal(alertTitle(alert({ kind: 'already_denied' })), '工具已拒绝');
    assert.equal(alertTitle(alert({ kind: 'needs_decision' })), '等待你审批');
    assert.equal(alertRequiresDecision(alert({ kind: 'info' })), false);
    assert.equal(alertRequiresDecision(alert({ kind: 'already_denied' })), false);
    assert.equal(alertRequiresDecision(alert({ kind: 'needs_decision' })), true);
    assert.equal(alertRequiresDecision(alert({})), true, 'missing kind defaults to needs_decision (backward compatible)');
  });
});
