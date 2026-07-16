import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { loadConfig } from '@los/infra/config';
import { ensureExecutionStore, transitionExecutionState } from './execution-store.js';
import { createRunSpec, ensureRunSpecStore, loadRunSpec } from './run-specs.js';
import { createTaskRun, ensureTaskRunStore, loadTaskRun, updateTaskRunFields } from './task-runs.js';
import {
  ensureDeadLetterStore,
  writeDeadLetterEvent,
} from './dead-letter.js';
import { requeueDeadLetterEvent, summarizeDeadLetterEvents } from './dead-letter-recovery.js';
import { runDeadLetterGovernance } from './dead-letter-governance.js';

test('dead-letter summary classifies reasons and lease expiry requeue is idempotent', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runSpecId = `dlq-test-run-${suffix}`;
  const taskRunId = `dlq-test-task-${suffix}`;
  try {
    await ensureRunSpecStore();
    await ensureTaskRunStore();
    await ensureExecutionStore();
    await ensureDeadLetterStore();
    await createRunSpec({
      id: runSpecId,
      sessionId: `dlq-test-session-${suffix}`,
      prompt: 'retry this expired task',
      workspaceRoot: process.cwd(),
      toolMode: 'read-only',
    });
    await transitionExecutionState({
      entityType: 'run_spec', entityId: runSpecId, to: 'running',
      sessionId: `dlq-test-session-${suffix}`, reason: 'test_start',
    });
    await transitionExecutionState({
      entityType: 'run_spec', entityId: runSpecId, to: 'blocked',
      sessionId: `dlq-test-session-${suffix}`, reason: 'test_expired',
    });
    await createTaskRun({
      id: taskRunId,
      sessionId: `dlq-test-session-${suffix}`,
      runSpecId,
      workspaceRoot: process.cwd(),
      toolMode: 'read-only',
      promptPreview: 'retry this expired task',
    });
    await transitionExecutionState({
      entityType: 'task_run', entityId: taskRunId, to: 'running',
      sessionId: `dlq-test-session-${suffix}`, reason: 'test_start',
    });
    await updateTaskRunFields(taskRunId, { leaseExpiresAt: new Date(Date.now() - 1000) });
    const event = await writeDeadLetterEvent({
      taskRunId,
      runSpecId,
      reason: 'lease_expired',
      eventPayload: { test: true },
    });

    const before = await summarizeDeadLetterEvents();
    assert.equal(before.byReason.lease_expired.unacknowledged >= 1, true);
    const dryRun = await runDeadLetterGovernance({ dryRun: true, limit: 10 });
    assert.ok(dryRun.candidateIds.includes(event.id));
    assert.deepEqual(dryRun.requeuedTaskRunIds, []);
    const originalTask = await loadTaskRun(taskRunId);
    assert.ok(originalTask);
    const scheduledInputs: Array<{ taskRunId?: string; attempt?: number; prompt: string }> = [];
    const first = await requeueDeadLetterEvent(event.id, {
      scheduler: async (input) => {
        scheduledInputs.push({ taskRunId: input.taskRunId, attempt: input.attempt, prompt: input.prompt });
        return { status: 'deduplicated', sessionId: originalTask.sessionId, taskRun: originalTask };
      },
    });
    assert.equal(first.status, 'requeued');
    assert.equal(scheduledInputs.length, 1);
    assert.equal(scheduledInputs[0]?.attempt, 2);
    assert.equal(scheduledInputs[0]?.prompt, 'retry this expired task');
    await waitForRunSpecStatus(runSpecId, 'blocked');

    const second = await requeueDeadLetterEvent(event.id, { scheduler: async () => undefined });
    assert.equal(second.status, 'already_requeued');
    const after = await summarizeDeadLetterEvents();
    assert.equal(after.byReason.lease_expired.requeued >= 1, true);
  } finally {
    await getDb().query('DELETE FROM dead_letter_events WHERE task_run_id = $1 OR run_spec_id = $2', [taskRunId, runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_runs WHERE id = $1', [taskRunId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

async function waitForRunSpecStatus(runSpecId: string, status: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const runSpec = await loadRunSpec(runSpecId);
    if (runSpec?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`run spec ${runSpecId} did not reach ${status}`);
}
