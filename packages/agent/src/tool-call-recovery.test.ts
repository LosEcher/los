import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import {
  applyToolCallRecoveryTransitionForRunSpec,
  evaluateToolCallRecovery,
  readToolCallRecoveryForRunSpec,
} from './tool-call-recovery.js';
import { listSessionEvents } from './session-events.js';
import { createTaskRun, loadTaskRun } from './task-runs.js';
import { createRunSpec, loadRunSpec } from './run-specs.js';
import { createToolCallState, loadToolCallState, updateToolCallState, type ToolCallStateRecord } from './tool-call-states.js';
import { transitionExecutionState } from './execution-store.js';

test('tool call recovery recommends retry, resume, cancel, or operator action from durable state', () => {
  const now = '2026-06-06T00:00:00.000Z';
  const records: ToolCallStateRecord[] = [
    toolState({ id: 'tool-active-stale', state: 'running', updatedAt: '2026-06-05T23:50:00.000Z' }),
    toolState({ id: 'tool-retryable', state: 'failed', idempotent: true, attempt: 1, maxAttempts: 3 }),
    toolState({ id: 'tool-exhausted', state: 'failed', idempotent: true, attempt: 3, maxAttempts: 3 }),
    toolState({ id: 'tool-denied', state: 'denied' }),
    toolState({ id: 'tool-ok', state: 'succeeded' }),
  ];

  const recover = evaluateToolCallRecovery(records, { now, staleMs: 60_000 });
  assert.equal(recover.status, 'action_required');
  assert.equal(recover.recommendation, 'operator_attention');
  assert.deepEqual(recover.resumeToolCallIds, ['tool-active-stale']);
  assert.deepEqual(recover.retryToolCallIds, ['tool-retryable']);
  assert.deepEqual(recover.operatorAttentionToolCallIds, ['tool-exhausted', 'tool-denied']);
  assert.deepEqual(recover.terminalFailedToolCallIds, ['tool-retryable', 'tool-exhausted']);

  const cancel = evaluateToolCallRecovery(records, { now, intent: 'cancel' });
  assert.equal(cancel.recommendation, 'cancel');
  assert.deepEqual(cancel.cancelToolCallIds, ['tool-active-stale']);
});

test('tool call recovery stays clean for completed durable state', () => {
  const decision = evaluateToolCallRecovery([
    toolState({ id: 'tool-ok', state: 'succeeded' }),
    toolState({ id: 'tool-skipped', state: 'skipped' }),
  ]);

  assert.equal(decision.status, 'clean');
  assert.equal(decision.recommendation, 'none');
  assert.deepEqual(decision.reasons, []);
});

test('tool call recovery reads durable tool_call_states by run spec', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `session-tool-recovery-${suffix}`;
  const runSpecId = `run-tool-recovery-${suffix}`;
  const failedCallId = `tool-failed-${suffix}`;
  const runningCallId = `tool-running-${suffix}`;
  try {
    await createToolCallState({
      id: failedCallId,
      sessionId,
      runSpecId,
      taskRunId: `task-${suffix}`,
      turn: 1,
      toolName: 'read_file',
      state: 'requested',
      inputJson: { path: 'README.md' },
      maxAttempts: 2,
      idempotent: true,
    });
    await updateToolCallState(failedCallId, sessionId, {
      state: 'failed',
      error: 'temporary failure',
      attempt: 1,
    });
    await createToolCallState({
      id: runningCallId,
      sessionId,
      runSpecId,
      taskRunId: `task-${suffix}`,
      turn: 2,
      toolName: 'search',
      state: 'running',
      inputJson: { query: 'los' },
      maxAttempts: 1,
      idempotent: true,
    });

    const decision = await readToolCallRecoveryForRunSpec(runSpecId, {
      now: new Date(Date.now() + 10_000),
      staleMs: 0,
    });

    assert.equal(decision.status, 'action_required');
    assert.deepEqual(decision.retryToolCallIds, [failedCallId]);
    assert.deepEqual(decision.resumeToolCallIds, [runningCallId]);
  } finally {
    await getDb().query('DELETE FROM tool_call_states WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('tool call recovery applies cancel and operator-attention transitions', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const cancelSessionId = `session-tool-cancel-${suffix}`;
  const cancelRunSpecId = `run-tool-cancel-${suffix}`;
  const cancelTaskRunId = `task-tool-cancel-${suffix}`;
  const cancelCallId = `tool-cancel-${suffix}`;
  const attentionSessionId = `session-tool-attention-${suffix}`;
  const attentionRunSpecId = `run-tool-attention-${suffix}`;
  const attentionTaskRunId = `task-tool-attention-${suffix}`;
  const attentionCallId = `tool-attention-${suffix}`;
  try {
    await createRunSpec({
      id: cancelRunSpecId,
      sessionId: cancelSessionId,
      prompt: 'cancel recovery',
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      maxLoops: 1,
    });
    await createTaskRun({
      id: cancelTaskRunId,
      sessionId: cancelSessionId,
      runSpecId: cancelRunSpecId,
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      promptPreview: 'cancel recovery',
      status: 'running',
    });
    await createToolCallState({
      id: cancelCallId,
      sessionId: cancelSessionId,
      runSpecId: cancelRunSpecId,
      taskRunId: cancelTaskRunId,
      turn: 1,
      toolName: 'read_file',
      state: 'running',
      inputJson: { path: 'README.md' },
    });

    const liveCancelled: string[] = [];
    const cancel = await applyToolCallRecoveryTransitionForRunSpec(cancelRunSpecId, {
      action: 'cancel',
      reason: 'test cancel transition',
      cancelLiveTaskRun: (taskRunId) => {
        liveCancelled.push(taskRunId);
        return true;
      },
    });

    assert.equal(cancel.runSpecStatus, 'cancelled');
    assert.deepEqual(cancel.transitionedToolCallIds, [cancelCallId]);
    assert.deepEqual(cancel.transitionedTaskRunIds, [cancelTaskRunId]);
    assert.deepEqual(cancel.liveCancelledTaskRunIds, [cancelTaskRunId]);
    assert.deepEqual(liveCancelled, [cancelTaskRunId]);
    assert.equal((await loadRunSpec(cancelRunSpecId))?.status, 'cancelled');
    assert.equal((await loadTaskRun(cancelTaskRunId))?.status, 'cancelled');
    assert.equal((await loadToolCallState(cancelCallId, cancelSessionId))?.state, 'skipped');
    const cancelEvents = await listSessionEvents(cancelSessionId, 20);
    assert.ok(cancelEvents.some(event => event.type === 'run.recovery_cancelled'));

    await createRunSpec({
      id: attentionRunSpecId,
      sessionId: attentionSessionId,
      prompt: 'operator attention recovery',
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      maxLoops: 1,
    });
    await transitionExecutionState({
      entityType: 'run_spec',
      entityId: attentionRunSpecId,
      to: 'running',
      reason: 'test setup',
    });
    await createTaskRun({
      id: attentionTaskRunId,
      sessionId: attentionSessionId,
      runSpecId: attentionRunSpecId,
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      promptPreview: 'operator attention recovery',
      status: 'failed',
    });
    await createToolCallState({
      id: attentionCallId,
      sessionId: attentionSessionId,
      runSpecId: attentionRunSpecId,
      taskRunId: attentionTaskRunId,
      turn: 1,
      toolName: 'write_file',
      state: 'failed',
      inputJson: { path: 'README.md' },
      maxAttempts: 1,
      idempotent: false,
    });

    const attention = await applyToolCallRecoveryTransitionForRunSpec(attentionRunSpecId, {
      action: 'operator_attention',
      reason: 'needs operator decision',
      actor: 'test',
    });

    assert.equal(attention.runSpecStatus, 'blocked');
    assert.equal(attention.decision.recommendation, 'operator_attention');
    assert.deepEqual(attention.decision.operatorAttentionToolCallIds, [attentionCallId]);
    assert.equal((await loadRunSpec(attentionRunSpecId))?.status, 'blocked');
    const attentionEvents = await listSessionEvents(attentionSessionId, 20);
    assert.ok(attentionEvents.some(event => event.type === 'run.operator_attention_required'));
  } finally {
    await getDb().query('DELETE FROM tool_call_states WHERE session_id IN ($1, $2)', [cancelSessionId, attentionSessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_runs WHERE run_spec_id IN ($1, $2)', [cancelRunSpecId, attentionRunSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id IN ($1, $2)', [cancelRunSpecId, attentionRunSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id IN ($1, $2)', [cancelSessionId, attentionSessionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

function toolState(input: Partial<ToolCallStateRecord> & Pick<ToolCallStateRecord, 'id' | 'state'>): ToolCallStateRecord {
  return {
    id: input.id,
    sessionId: input.sessionId ?? 'session-tool-recovery',
    runSpecId: input.runSpecId ?? 'run-tool-recovery',
    taskRunId: input.taskRunId ?? 'task-tool-recovery',
    turn: input.turn ?? 1,
    toolName: input.toolName ?? 'read_file',
    state: input.state,
    inputJson: input.inputJson ?? {},
    outputSummary: input.outputSummary,
    error: input.error,
    durationMs: input.durationMs,
    attempt: input.attempt ?? 1,
    maxAttempts: input.maxAttempts ?? 1,
    idempotent: input.idempotent ?? false,
    retryPolicyJson: input.retryPolicyJson ?? {},
    requestedAt: input.requestedAt ?? '2026-06-05T23:59:00.000Z',
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    createdAt: input.createdAt ?? '2026-06-05T23:59:00.000Z',
    updatedAt: input.updatedAt ?? '2026-06-05T23:59:30.000Z',
  };
}
