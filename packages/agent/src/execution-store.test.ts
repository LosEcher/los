import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { ExecutionTransitionError } from './execution-transitions.js';
import { ensureExecutionStore, transitionExecutionState } from './execution-store.js';
import { ensureRunSpecVerificationPhase } from './run-phase-transitions.js';
import { createRunSpec, loadRunSpec } from './run-specs.js';
import { listSessionEvents } from './session-events.js';
import { createTaskRun, loadTaskRun } from './task-runs.js';
import { createToolCallState, loadToolCallState } from './tool-call-states.js';
import { createVerificationRecord, listVerificationRecordsForRunSpec, loadVerificationRecord } from './verification-records.js';

test('execution store transitions state and writes event plus outbox in one command', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runSpecId = `run-execution-store-${suffix}`;
  const sessionId = `session-execution-store-${suffix}`;

  try {
    await createRunSpec({
      id: runSpecId,
      sessionId,
      prompt: 'transition run spec',
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      maxLoops: 1,
    });

    const result = await transitionExecutionState({
      entityType: 'run_spec',
      entityId: runSpecId,
      to: 'running',
      reason: 'scheduler_start',
      commandId: `command-${suffix}`,
      correlationId: `trace-${suffix}`,
      nodeId: 'test-node',
    });

    assert.equal(result.from, 'created');
    assert.equal(result.to, 'running');
    assert.equal(result.sessionId, sessionId);
    assert.equal(result.runSpecId, runSpecId);
    assert.equal(result.event.type, 'run_spec.running');
    assert.equal(result.event.source, 'los.execution');
    assert.deepEqual(result.event.payload, {
      entityType: 'run_spec',
      entityId: runSpecId,
      from: 'created',
      to: 'running',
      reason: 'scheduler_start',
      commandId: `command-${suffix}`,
      correlationId: `trace-${suffix}`,
      nodeId: 'test-node',
    });

    const stored = await loadRunSpec(runSpecId);
    assert.equal(stored?.status, 'running');

    const outbox = await getDb().query<{
      payload_json: Record<string, unknown>;
      event_type: string;
      session_event_id: string | number | null;
      legacy: boolean;
    }>(
      'SELECT event_type, session_event_id, payload_json, legacy FROM execution_outbox WHERE id = $1',
      [result.outboxId],
    );
    assert.equal(outbox.rows[0]?.event_type, 'run_spec.running');
    assert.equal(Number(outbox.rows[0]?.session_event_id), result.event.id);
    assert.equal(outbox.rows[0]?.legacy, false);
    assert.deepEqual(outbox.rows[0]?.payload_json, result.event.payload);
  } finally {
    await getDb().query('DELETE FROM execution_outbox WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('execution store rejects invalid transitions without writing event or outbox', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runSpecId = `run-execution-invalid-${suffix}`;
  const taskRunId = `task-execution-invalid-${suffix}`;
  const sessionId = `session-execution-invalid-${suffix}`;

  try {
    await ensureExecutionStore();
    await createRunSpec({
      id: runSpecId,
      sessionId,
      prompt: 'reject invalid transition',
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      maxLoops: 1,
    });
    await createTaskRun({
      id: taskRunId,
      sessionId,
      runSpecId,
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      promptPreview: 'reject invalid transition',
      status: 'queued',
    });

    await assert.rejects(
      () => transitionExecutionState({
        entityType: 'task_run',
        entityId: taskRunId,
        to: 'succeeded',
        reason: 'invalid_direct_completion',
      }),
      ExecutionTransitionError,
    );

    const taskRun = await loadTaskRun(taskRunId);
    assert.equal(taskRun?.status, 'queued');
    assert.deepEqual(await listSessionEvents(sessionId), []);

    const outbox = await getDb().query<{ count: string }>(
      'SELECT count(*)::text AS count FROM execution_outbox WHERE session_id = $1',
      [sessionId],
    );
    assert.equal(outbox.rows[0]?.count, '0');
  } finally {
    await getDb().query('DELETE FROM execution_outbox WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_runs WHERE id = $1', [taskRunId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('execution store supports tool and verification state transitions', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runSpecId = `run-execution-related-${suffix}`;
  const taskRunId = `task-execution-related-${suffix}`;
  const sessionId = `session-execution-related-${suffix}`;
  const toolCallId = `tool-execution-related-${suffix}`;
  const verificationId = `verification-execution-related-${suffix}`;

  try {
    await createRunSpec({
      id: runSpecId,
      sessionId,
      prompt: 'transition related execution entities',
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      maxLoops: 1,
    });
    await createTaskRun({
      id: taskRunId,
      sessionId,
      runSpecId,
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      promptPreview: 'transition related execution entities',
      status: 'running',
    });
    await createToolCallState({
      id: toolCallId,
      sessionId,
      runSpecId,
      taskRunId,
      turn: 1,
      toolName: 'read_file',
      state: 'failed',
      inputJson: { path: 'AGENTS.md' },
      maxAttempts: 2,
      idempotent: true,
    });
    await createVerificationRecord({
      id: verificationId,
      sessionId,
      runSpecId,
      taskRunId,
      checkName: 'pnpm check',
      command: 'pnpm check',
      status: 'failed',
    });

    const toolResult = await transitionExecutionState({
      entityType: 'tool_call_state',
      entityId: toolCallId,
      sessionId,
      to: 'retrying',
      reason: 'retry_idempotent_tool',
      attempt: 2,
    });
    assert.equal(toolResult.taskRunId, taskRunId);

    const verificationResult = await transitionExecutionState({
      entityType: 'verification_record',
      entityId: verificationId,
      to: 'running',
      reason: 'operator_rerun',
    });
    assert.equal(verificationResult.runSpecId, runSpecId);

    const toolState = await loadToolCallState(toolCallId, sessionId);
    assert.equal(toolState?.state, 'retrying');
    assert.equal(toolState?.attempt, 2);

    const verification = await loadVerificationRecord(verificationId);
    assert.equal(verification?.status, 'running');
    assert.equal(verification?.completedAt, undefined);

    const events = await listSessionEvents(sessionId);
    assert.equal(events.filter(event => event.source === 'los.execution').length, 2);
  } finally {
    await getDb().query('DELETE FROM execution_outbox WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM verification_records WHERE id = $1', [verificationId]).catch(() => undefined);
    await getDb().query('DELETE FROM tool_call_states WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_runs WHERE id = $1', [taskRunId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('run spec success is atomic with required verification and phase synchronization', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runSpecId = `run-success-gate-${suffix}`;
  const sessionId = `session-success-gate-${suffix}`;

  try {
    await createRunSpec({
      id: runSpecId,
      sessionId,
      prompt: 'enforce success verification gate',
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      runContract: {
        mode: 'execution',
        phase: 'plan_approved',
        editableSurfaces: ['packages/agent/src/execution-store.ts'],
        requiredChecks: ['pnpm check'],
        planRevision: 2,
        plan: [{
          id: 'step-1',
          title: 'Enforce success gate',
          description: 'Require persisted verification before success.',
          dependsOnIds: [],
          editableSurfaces: ['packages/agent/src/execution-store.ts'],
          completionCriteria: 'The success transition is transactionally gated.',
        }],
      },
    });

    await transitionExecutionState({
      entityType: 'run_spec',
      entityId: runSpecId,
      to: 'running',
      reason: 'start_verified_run',
    });
    assert.equal((await loadRunSpec(runSpecId))?.runContract?.phase, 'executing');

    await assert.rejects(
      () => transitionExecutionState({
        entityType: 'run_spec',
        entityId: runSpecId,
        to: 'succeeded',
        reason: 'premature_success',
      }),
      /must transition to 'verifying' first/,
    );

    const blocked = await loadRunSpec(runSpecId);
    assert.equal(blocked?.status, 'running');
    assert.equal(blocked?.runContract?.phase, 'executing');
    assert.equal((await listSessionEvents(sessionId)).some((event) => event.type === 'run_spec.succeeded'), false);

    await ensureRunSpecVerificationPhase(runSpecId, 'begin_verification_test');
    const oldVerificationId = `verification-${runSpecId}-r1-1`;
    await createVerificationRecord({
      id: oldVerificationId,
      sessionId,
      runSpecId,
      checkName: 'pnpm check',
      command: 'pnpm check',
      planRevision: 1,
      status: 'succeeded',
      required: false,
    });
    const attemptedReactivation = await createVerificationRecord({
      id: oldVerificationId,
      sessionId,
      runSpecId,
      checkName: 'pnpm check',
      command: 'pnpm check',
      planRevision: 1,
      status: 'succeeded',
      required: true,
    });
    assert.equal(attemptedReactivation.required, false);
    await assert.rejects(
      () => transitionExecutionState({
        entityType: 'run_spec',
        entityId: runSpecId,
        to: 'succeeded',
        reason: 'unverified_success',
      }),
      /cannot be marked succeeded.*pnpm check/,
    );

    const [verification] = await listVerificationRecordsForRunSpec(runSpecId, { planRevision: 2 });
    assert.ok(verification);
    await transitionExecutionState({
      entityType: 'verification_record',
      entityId: verification.id,
      to: 'running',
      reason: 'run_required_check',
    });
    await transitionExecutionState({
      entityType: 'verification_record',
      entityId: verification.id,
      to: 'succeeded',
      reason: 'required_check_passed',
    });
    await transitionExecutionState({
      entityType: 'run_spec',
      entityId: runSpecId,
      to: 'succeeded',
      reason: 'verified_success',
    });

    const succeeded = await loadRunSpec(runSpecId);
    assert.equal(succeeded?.status, 'succeeded');
    assert.equal(succeeded?.runContract?.phase, 'succeeded');
    assert.equal(succeeded?.runContract?.previousPhase, 'verifying');
  } finally {
    await getDb().query('DELETE FROM execution_outbox WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('run spec cancellation synchronizes the cancelled contract phase', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runSpecId = `run-cancel-phase-${suffix}`;
  const sessionId = `session-cancel-phase-${suffix}`;

  try {
    await createRunSpec({
      id: runSpecId,
      sessionId,
      prompt: 'synchronize cancellation phase',
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      runContract: {
        executionMode: 'lightweight',
        phase: 'planning',
        editableSurfaces: [],
      },
    });
    await transitionExecutionState({ entityType: 'run_spec', entityId: runSpecId, to: 'running', reason: 'start_lightweight' });
    await transitionExecutionState({ entityType: 'run_spec', entityId: runSpecId, to: 'cancelled', reason: 'operator_cancelled' });

    const cancelled = await loadRunSpec(runSpecId);
    assert.equal(cancelled?.status, 'cancelled');
    assert.equal(cancelled?.runContract?.phase, 'cancelled');
    assert.equal(cancelled?.runContract?.previousPhase, 'executing');
  } finally {
    await getDb().query('DELETE FROM execution_outbox WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});
