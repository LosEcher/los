import assert from 'node:assert/strict';
import test from 'node:test';

import { getDb } from '@los/infra/db';

import { transitionExecutionState } from '../execution-store.js';
import { ensureRunSpecVerificationPhase } from '../run-phase-transitions.js';
import { createRunSpec, loadRunSpec } from '../run-specs.js';
import { listSessionEvents } from '../session-events.js';
import { loadTodo } from '../todos.js';
import { listVerificationRecordsForRunSpec } from '../verification-records.js';
import { createWorkItemRevision } from './revision-loop.js';
import { createWorkItem, loadWorkItemProjection } from './projection.js';
import { linkWorkItemRun, listWorkItemRunLinks } from './store.js';

test('verification failure stays blocked and repeated feedback stops with one attention event', async () => {
  const fixture = await createRevisionFixture('no-progress');
  try {
    await assert.rejects(
      () => transitionExecutionState({
        entityType: 'run_spec',
        entityId: fixture.runSpecId,
        to: 'succeeded',
        reason: 'must_not_bypass_failed_verification',
      }),
      /verification|pending or failed/,
    );
    await transitionExecutionState({
      entityType: 'run_spec',
      entityId: fixture.runSpecId,
      to: 'blocked',
      reason: 'verification_failed',
    });

    const first = await createWorkItemRevision({
      runSpecId: fixture.runSpecId,
      reason: 'pnpm check failed',
      trigger: 'verification_failed',
    });
    assert.equal(first.exhausted, false);
    assert.equal(first.planRevision, 2);

    const duplicate = await createWorkItemRevision({
      runSpecId: fixture.runSpecId,
      reason: 'pnpm check failed',
      trigger: 'verification_failed',
    });
    assert.equal(duplicate.exhausted, false);
    assert.equal(duplicate.planRevision, 2);

    const revised = await loadRunSpec(fixture.runSpecId);
    assert.equal(revised?.runContract?.planHistory?.[0]?.revision, 1);
    assert.equal(revised?.runContract?.planParentRevision, 1);
    assert.equal(revised?.runContract?.plan?.at(-1)?.id, 'recovery-2');
    assert.equal((await listWorkItemRunLinks(fixture.workItemId))[0]?.relationKind, 'recovery');
    assert.deepEqual((await loadTodo(fixture.workItemId))?.metadata.nonGoals, ['preserve this metadata']);

    await failCurrentVerification(fixture.runSpecId);
    const exhausted = await createWorkItemRevision({
      runSpecId: fixture.runSpecId,
      reason: 'pnpm check failed',
      trigger: 'verification_failed',
    });
    assert.equal(exhausted.exhausted, true);
    assert.equal(exhausted.exhaustionReason, 'no_progress');
    assert.ok(exhausted.attentionEventId);

    const repeated = await createWorkItemRevision({
      runSpecId: fixture.runSpecId,
      reason: 'pnpm check failed',
      trigger: 'verification_failed',
    });
    assert.equal(repeated.attentionEventId, exhausted.attentionEventId);
    const attention = (await listSessionEvents(fixture.sessionId))
      .filter(event => event.type === 'run.operator_attention_required');
    assert.equal(attention.length, 1);
    assert.equal(attention[0]?.payload.exhaustionReason, 'no_progress');
  } finally {
    await cleanupRevisionFixture(fixture);
  }
});

test('revision retry budget exhaustion is durable and emits one attention event', async () => {
  const fixture = await createRevisionFixture('budget');
  try {
    await transitionExecutionState({
      entityType: 'run_spec',
      entityId: fixture.runSpecId,
      to: 'blocked',
      reason: 'review_requested',
    });
    const second = await createWorkItemRevision({
      runSpecId: fixture.runSpecId,
      reason: 'first requested correction',
      trigger: 'revision_requested',
    });
    const third = await createWorkItemRevision({
      runSpecId: fixture.runSpecId,
      reason: 'second requested correction',
      trigger: 'revision_requested',
    });
    assert.equal(second.planRevision, 2);
    assert.equal(third.planRevision, 3);

    const exhausted = await createWorkItemRevision({
      runSpecId: fixture.runSpecId,
      reason: 'third requested correction',
      trigger: 'revision_requested',
    });
    assert.equal(exhausted.exhausted, true);
    assert.equal(exhausted.exhaustionReason, 'retry_budget_exhausted');

    const repeated = await createWorkItemRevision({
      runSpecId: fixture.runSpecId,
      reason: 'another correction after exhaustion',
      trigger: 'revision_requested',
    });
    assert.equal(repeated.attentionEventId, exhausted.attentionEventId);
    const attention = (await listSessionEvents(fixture.sessionId))
      .filter(event => event.type === 'run.operator_attention_required');
    assert.equal(attention.length, 1);
    assert.equal(attention[0]?.payload.exhaustionReason, 'retry_budget_exhausted');
    assert.deepEqual((await loadRunSpec(fixture.runSpecId))?.runContract?.planHistory?.map(item => item.revision), [1, 2]);
  } finally {
    await cleanupRevisionFixture(fixture);
  }
});

async function createRevisionFixture(label: string): Promise<{
  workItemId: string;
  runSpecId: string;
  sessionId: string;
}> {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const workItem = await createWorkItem({
    projectId: 'los',
    goal: `Revision fixture ${suffix}`,
    mode: 'execution',
    editableSurfaces: ['packages/agent/src/work-items'],
    nonGoals: ['preserve this metadata'],
    requiredChecks: ['pnpm check'],
    stopConditions: ['retry budget exhausted'],
    toolMode: 'project-write',
  });
  const runSpecId = `run-revision-${suffix}`;
  const sessionId = `session-revision-${suffix}`;
  await createRunSpec({
    id: runSpecId,
    sessionId,
    projectId: 'los',
    prompt: 'exercise the persisted revision loop',
    workspaceRoot: '/tmp/los-revision-loop',
    toolMode: 'project-write',
    runContract: {
      mode: 'execution',
      phase: 'plan_approved',
      editableSurfaces: ['packages/agent/src/work-items'],
      requiredChecks: ['pnpm check'],
      planRevision: 1,
      plan: [{
        id: 'step-1',
        title: 'Implement the requested change',
        description: 'Complete the bounded implementation.',
        dependsOnIds: [],
        editableSurfaces: ['packages/agent/src/work-items'],
        completionCriteria: 'The required verification passes.',
      }],
    },
  });
  await linkWorkItemRun({
    workItemId: workItem.id,
    runSpecId,
    sessionId,
    relationKind: 'execution',
  });
  await transitionExecutionState({
    entityType: 'run_spec',
    entityId: runSpecId,
    to: 'running',
    reason: 'fixture_execution_started',
  });
  await ensureRunSpecVerificationPhase(runSpecId, 'fixture_execution_completed');
  await failCurrentVerification(runSpecId);
  assert.equal((await loadWorkItemProjection(workItem.id))?.evidence.verificationFailed, 1);
  return { workItemId: workItem.id, runSpecId, sessionId };
}

async function failCurrentVerification(runSpecId: string): Promise<void> {
  const runSpec = await loadRunSpec(runSpecId);
  const planRevision = runSpec?.runContract?.planRevision ?? 1;
  const records = await listVerificationRecordsForRunSpec(runSpecId, { planRevision });
  const record = records.find(item => item.required && item.status === 'required');
  assert.ok(record, `revision ${planRevision} should have a required verification record`);
  await transitionExecutionState({
    entityType: 'verification_record',
    entityId: record.id,
    to: 'running',
    reason: 'fixture_verification_started',
  });
  await transitionExecutionState({
    entityType: 'verification_record',
    entityId: record.id,
    to: 'failed',
    reason: 'fixture_verification_failed',
  });
}

async function cleanupRevisionFixture(fixture: {
  workItemId: string;
  runSpecId: string;
  sessionId: string;
}): Promise<void> {
  const db = getDb();
  await db.query('DELETE FROM execution_outbox WHERE run_spec_id = $1', [fixture.runSpecId]).catch(() => undefined);
  await db.query('DELETE FROM session_events WHERE session_id = $1', [fixture.sessionId]).catch(() => undefined);
  await db.query('DELETE FROM verification_records WHERE run_spec_id = $1', [fixture.runSpecId]).catch(() => undefined);
  await db.query('DELETE FROM task_runs WHERE run_spec_id = $1', [fixture.runSpecId]).catch(() => undefined);
  await db.query('DELETE FROM work_item_runs WHERE work_item_id = $1', [fixture.workItemId]).catch(() => undefined);
  await db.query('DELETE FROM run_specs WHERE id = $1', [fixture.runSpecId]).catch(() => undefined);
  await db.query('DELETE FROM todos WHERE id = $1', [fixture.workItemId]).catch(() => undefined);
}
