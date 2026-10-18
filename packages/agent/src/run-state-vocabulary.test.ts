import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRunStateProjection, type RunStateProjection } from './run-state-vocabulary.js';
import type { RunSpecRecord } from './run-specs.js';
import type { TaskRunRecord } from './task-runs.js';
import type { ToolCallRecoveryDecision } from './tool-call-recovery.js';
import type { VerificationRecord } from './verification-records.js';

test('run state projection prioritizes recovery-grade next actions', () => {
  const projection = buildRunStateProjection({
    runSpec: runSpec({ status: 'blocked' }),
    taskRuns: [taskRun({ id: 'task-1', status: 'failed' })],
    verificationRecords: [verification({ id: 'verification-1', status: 'failed' })],
    recovery: recovery({ recommendation: 'retry', retryToolCallIds: ['tool-1'] }),
  });

  assert.equal(projection.phase, 'blocked');
  assert.equal(projection.action, 'recover_tools');
  assert.deepEqual(projection.ids.failedVerificationRecordIds, ['verification-1']);
  assert.deepEqual(projection.ids.failedTaskRunIds, ['task-1']);
  assert.equal(projection.counts.taskRuns.failed, 1);
  assert.equal(projection.counts.verificationRecords.failed, 1);
  assertBlocker(projection, 'tool_recovery', ['tool-1']);
  assertBlocker(projection, 'verification', ['verification-1']);
  assertBlocker(projection, 'failed_task', ['task-1']);
});

test('run state projection waits for active work before terminal inspection', () => {
  const projection = buildRunStateProjection({
    runSpec: runSpec({ status: 'running' }),
    taskRuns: [taskRun({ id: 'task-active', status: 'running' })],
    verificationRecords: [],
    recovery: recovery(),
  });

  assert.equal(projection.action, 'wait_for_task');
  assert.deepEqual(projection.ids.activeTaskRunIds, ['task-active']);
  assertBlocker(projection, 'active_task', ['task-active']);
});

test('run state projection marks satisfied runs as no action', () => {
  const projection = buildRunStateProjection({
    runSpec: runSpec({ status: 'succeeded' }),
    taskRuns: [taskRun({ id: 'task-ok', status: 'succeeded' })],
    verificationRecords: [verification({ id: 'verification-ok', status: 'succeeded' })],
    recovery: recovery(),
  });

  assert.equal(projection.action, 'none');
  assert.equal(projection.blockers.length, 0);
  assert.equal(projection.summary, 'run is succeeded');
});

function assertBlocker(projection: RunStateProjection, kind: string, ids: string[]): void {
  const blocker = projection.blockers.find(item => item.kind === kind);
  assert.ok(blocker, `expected blocker ${kind}`);
  assert.deepEqual(blocker.ids, ids);
}

function runSpec(input: Partial<RunSpecRecord>): RunSpecRecord {
  return {
    id: 'run-1',
    sessionId: 'session-1',
    prompt: 'test run state',
    modelSettings: {},
    workspaceRoot: process.cwd(),
    toolMode: 'project-write',
    allowedTools: [],
    toolRetry: {},
    maxLoops: 1,
    mcpServers: [],
    status: 'created',
    createdAt: '2026-06-07T00:00:00.000Z',
    updatedAt: '2026-06-07T00:00:00.000Z',
    ...input,
  };
}

function taskRun(input: Partial<TaskRunRecord>): TaskRunRecord {
  return {
    id: 'task-1',
    sessionId: 'session-1',
    runSpecId: 'run-1',
    traceId: 'trace-1',
    workspaceRoot: process.cwd(),
    toolMode: 'project-write',
    status: 'queued',
    attempt: 1,
    promptPreview: 'test run state',
    metadata: {},
    leaseVersion: 0,
    createdAt: '2026-06-07T00:00:00.000Z',
    updatedAt: '2026-06-07T00:00:00.000Z',
    ...input,
  };
}

function verification(input: Partial<VerificationRecord>): VerificationRecord {
  return {
    id: 'verification-1',
    sessionId: 'session-1',
    runSpecId: 'run-1',
    checkName: 'pnpm check',
    kind: 'command',
    independence: 'deterministic',
    planRevision: 1,
    status: 'required',
    required: true,
    createdAt: '2026-06-07T00:00:00.000Z',
    updatedAt: '2026-06-07T00:00:00.000Z',
    ...input,
  };
}

function recovery(input: Partial<ToolCallRecoveryDecision> = {}): ToolCallRecoveryDecision {
  const recommendation = input.recommendation ?? 'none';
  return {
    status: recommendation === 'none' ? 'clean' : 'action_required',
    recommendation,
    retryToolCallIds: [],
    resumeToolCallIds: [],
    cancelToolCallIds: [],
    operatorAttentionToolCallIds: [],
    terminalFailedToolCallIds: [],
    activeToolCallIds: [],
    reasons: [],
    ...input,
  };
}

test('run state projection carries placement facts (observed, not normalized)', () => {
  const projection = buildRunStateProjection({
    runSpec: runSpec({ id: 'run-placement', status: 'succeeded' }),
    taskRuns: [
      taskRun({ id: 'task-a', status: 'succeeded', nodeId: 'mbp-executor-1', provider: 'deepseek', model: 'deepseek-v4', workspaceRoot: '/tmp/ws-a' }),
      taskRun({ id: 'task-b', status: 'succeeded', nodeId: 'mbp-executor-1', provider: 'deepseek', model: 'deepseek-v4', workspaceRoot: '/tmp/ws-a' }),
      taskRun({ id: 'task-c', status: 'succeeded', nodeId: 'gateway-local', provider: 'kimi', model: 'kimi-k2', workspaceRoot: '/tmp/ws-b' }),
      // 没有落点 ⇒ 只体现在计数里（workspaceRoot 显式给值，避免继承 helper 的 cwd 默认值）
      taskRun({ id: 'task-d', status: 'succeeded', workspaceRoot: '/tmp/ws-a' }),
    ],
    verificationRecords: [],
    recovery: recovery(),
  });

  // 去重 + 稳定升序（确定性，便于断言与比对）
  assert.deepEqual(projection.placement.nodeIds, ['gateway-local', 'mbp-executor-1']);
  assert.deepEqual(projection.placement.providers, ['deepseek', 'kimi']);
  assert.deepEqual(projection.placement.models, ['deepseek-v4', 'kimi-k2']);
  assert.deepEqual(projection.placement.workspaceRoots, ['/tmp/ws-a', '/tmp/ws-b']);
  // `gateway-local` **必须原样保留**：它是"网关进程内执行"的真实落点，
  // 归一化掉它就等于把"字段被当成两种东西用"这个症状抹平
  assert.ok(projection.placement.nodeIds.includes('gateway-local'));
  // 缺失不补默认值，只计数
  assert.equal(projection.placement.taskRunsWithoutNode, 1);
});

test('run state projection placement is empty (not fabricated) when nothing ran', () => {
  const projection = buildRunStateProjection({
    runSpec: runSpec({ id: 'run-empty', status: 'created' }),
    taskRuns: [],
    verificationRecords: [],
    recovery: recovery(),
  });
  assert.deepEqual(projection.placement, {
    nodeIds: [], providers: [], models: [], workspaceRoots: [], taskRunsWithoutNode: 0,
  });
});
