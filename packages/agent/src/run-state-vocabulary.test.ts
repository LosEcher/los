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
