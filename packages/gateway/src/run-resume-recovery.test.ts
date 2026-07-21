import test from 'node:test';
import assert from 'node:assert/strict';

import { createRunSpec, approveRunSpecPhase } from '@los/agent/run-specs';
import { createTaskRun } from '@los/agent/task-runs';
import { transitionExecutionState } from '@los/agent/execution-store';
import { getDb } from '@los/infra/db';
import { recoverApprovedRunDispatches } from './run-resume-recovery.js';

test('startup recovery dispatches approved runs only when the revision has no attempt', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const recoverableId = `run-recover-approved-${suffix}`;
  const activeId = `run-recover-active-${suffix}`;
  const executingId = `run-recover-executing-${suffix}`;
  const activeTaskId = `task-recover-active-${suffix}`;
  const sessionIds = [
    `session-recover-approved-${suffix}`,
    `session-recover-active-${suffix}`,
    `session-recover-executing-${suffix}`,
  ];
  const dispatched: string[] = [];

  try {
    await Promise.all([
      createApprovedRun(recoverableId, sessionIds[0]),
      createApprovedRun(activeId, sessionIds[1]),
      createApprovedRun(executingId, sessionIds[2]),
    ]);
    await createTaskRun({
      id: activeTaskId,
      sessionId: sessionIds[1],
      runSpecId: activeId,
      dedupeKey: `run:${activeId}:execution:1`,
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      promptPreview: 'already active',
      status: 'queued',
    });
    await transitionExecutionState({
      entityType: 'run_spec',
      entityId: executingId,
      to: 'running',
      sessionId: sessionIds[2],
      reason: 'simulate_crash_after_run_transition',
    });

    const recovery = await recoverApprovedRunDispatches({
      dispatch: async (runSpecId) => {
        dispatched.push(runSpecId);
        return { runSpecId, status: 'deduplicated', planRevision: 1 };
      },
    });

    assert.equal(recovery.lockAcquired, true);
    assert.deepEqual(new Set(recovery.runSpecIds), new Set([recoverableId, executingId]));
    assert.deepEqual(new Set(dispatched), new Set([recoverableId, executingId]));
    assert.ok(!recovery.runSpecIds.includes(activeId));
  } finally {
    await getDb().query('DELETE FROM task_runs WHERE id = $1', [activeTaskId]).catch(() => undefined);
    await getDb().query('DELETE FROM execution_outbox WHERE run_spec_id = ANY($1::text[])', [[recoverableId, activeId, executingId]]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id = ANY($1::text[])', [sessionIds]).catch(() => undefined);
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = ANY($1::text[])', [[recoverableId, activeId, executingId]]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = ANY($1::text[])', [[recoverableId, activeId, executingId]]).catch(() => undefined);
  }
});

async function createApprovedRun(id: string, sessionId: string): Promise<void> {
  await createRunSpec({
    id,
    sessionId,
    prompt: 'Implement the approved plan',
    workspaceRoot: process.cwd(),
    toolMode: 'project-write',
    runContract: {
      mode: 'execution',
      executionMode: 'standard',
      phase: 'planning',
      planRevision: 1,
      plan: [{
        id: 'step-1',
        title: 'Implement',
        description: 'Apply the bounded change.',
        dependsOnIds: [],
        editableSurfaces: ['packages/gateway/src/'],
        completionCriteria: 'Focused checks pass.',
      }],
      requiredChecks: ['pnpm --filter @los/gateway check'],
    },
  });
  await approveRunSpecPhase(id, { actor: 'operator:test' });
}
