import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { evaluateToolCallRecovery, readToolCallRecoveryForRunSpec } from './tool-call-recovery.js';
import { createToolCallState, updateToolCallState, type ToolCallStateRecord } from './tool-call-states.js';

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
