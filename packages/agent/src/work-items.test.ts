import assert from 'node:assert/strict';
import test from 'node:test';

import { getDb } from '@los/infra/db';

import { createTodo, loadTodo } from './todos.js';
import {
  createWorkItem,
  linkWorkItemRun,
  listInboxEntries,
  listWorkItemRunLinks,
} from './work-items/index.js';
import type { WorkItemProjection } from './work-items/types.js';
import type { FeedAnalysisWorkItemEvidence } from './integration/feed-analysis-work-item.js';
import { _classifyWorkItemAttention } from './work-items/projection.js';
import { _assertResultCanBeAccepted } from './work-items/result-review.js';

test('work item creation persists a structured contract draft without starting a run', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const projection = await createWorkItem({
    projectId: 'los',
    title: `Work Item ${suffix}`,
    goal: 'Create a reviewable work item',
    mode: 'execution',
    editableSurfaces: ['packages/agent/src/work-items'],
    nonGoals: ['dispatch execution'],
    requiredChecks: ['pnpm --filter @los/agent test'],
    stopConditions: ['scope expands'],
    evidenceRequired: ['focused test output'],
    toolMode: 'project-write',
    priority: 'P1',
  });
  try {
    const todo = await loadTodo(projection.id);
    assert.equal(todo?.status, 'backlog');
    assert.equal(todo?.taskRunId, undefined);
    assert.equal(todo?.sessionId, undefined);
    assert.equal(projection.nextAction, 'start');
    assert.equal(projection.attentionState, 'none');
    assert.deepEqual(projection.runContractDraft, {
      mode: 'execution',
      goal: 'Create a reviewable work item',
      editableSurfaces: ['packages/agent/src/work-items'],
      toolMode: 'project-write',
      requiredChecks: ['pnpm --filter @los/agent test'],
      allowedSkippedChecks: [],
      stopConditions: ['scope expands'],
      evidenceRequired: ['focused test output'],
      externalEvidenceAllowed: [],
      rawEvidenceProhibited: [],
      phase: 'created',
    });
    assert.deepEqual(todo?.metadata.nonGoals, ['dispatch execution']);
  } finally {
    await getDb().query('DELETE FROM todos WHERE id = $1', [projection.id]);
  }
});

test('work item run linkage is stable and fills later task evidence', async () => {
  const projection = await createWorkItem({
    projectId: 'los',
    goal: `Link work item ${Date.now()}`,
    mode: 'audit',
    editableSurfaces: [],
    requiredChecks: [],
    stopConditions: [],
  });
  try {
    const first = await linkWorkItemRun({
      workItemId: projection.id,
      runSpecId: 'run-link-test',
      sessionId: 'session-link-test',
      relationKind: 'planning',
    });
    const updated = await linkWorkItemRun({
      workItemId: projection.id,
      runSpecId: 'run-link-test',
      taskRunId: 'task-link-test',
      sessionId: 'session-link-test',
      relationKind: 'execution',
    });
    assert.equal(first.id, updated.id);
    assert.equal(updated.taskRunId, 'task-link-test');
    assert.equal(updated.relationKind, 'execution');
    const links = await listWorkItemRunLinks(projection.id);
    assert.equal(links.length, 1);
  } finally {
    await getDb().query('DELETE FROM todos WHERE id = $1', [projection.id]);
  }
});

test('attention projection applies approval, verification, recovery, active, and review precedence', () => {
  const base = {
    todoStatus: 'in_progress',
    hasRunEvidence: true,
    verificationFailed: 0,
    verificationPending: 0,
  };
  assert.equal(_classifyWorkItemAttention({ ...base, phase: 'planning' }), 'approval_required');
  assert.equal(_classifyWorkItemAttention({
    ...base,
    phase: 'verifying',
    taskRunStatus: 'failed',
    verificationFailed: 1,
  }), 'verification_blocked');
  assert.equal(_classifyWorkItemAttention({ ...base, taskRunStatus: 'failed' }), 'recovery_required');
  assert.equal(_classifyWorkItemAttention({ ...base, taskRunStatus: 'running' }), 'running');
  assert.equal(_classifyWorkItemAttention({ ...base, taskRunStatus: 'succeeded' }), 'review_ready');
  assert.equal(_classifyWorkItemAttention({
    ...base,
    feedAnalysis: feedAnalysisEvidence({ dispatchStatus: 'completed', resultAvailable: false }),
  }), 'verification_blocked');
  assert.equal(_classifyWorkItemAttention({
    ...base,
    feedAnalysis: feedAnalysisEvidence({
      dispatchStatus: 'completed',
      resultAvailable: true,
      callback: { deadLetterCount: 1 },
    }),
  }), 'recovery_required');
  assert.equal(_classifyWorkItemAttention({ ...base, todoStatus: 'done', taskRunStatus: 'failed' }), 'none');
});

test('Inbox excludes terminal priority backlog before applying its result limit', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const projectId = `inbox-window-${suffix}`;
  const active = await createTodo({
    tenantId: 'local', projectId, title: 'Active P2 result', kind: 'task', status: 'backlog', priority: 'P2',
    source: 'scheduled-work',
    metadata: {
      scheduledWork: {
        scheduleId: `schedule-${suffix}`, runId: `schedule-run-${suffix}`, status: 'succeeded', summary: {},
      },
    },
  });
  try {
    await getDb().query(`
      INSERT INTO todos (id, tenant_id, project_id, title, kind, status, priority, source)
      SELECT 'todo-terminal-window-' || $1 || '-' || value, 'local', $2,
        'Completed priority item ' || value, 'task', 'done', 'P0', 'test'
      FROM generate_series(1, 101) AS series(value)
    `, [suffix, projectId]);
    const entries = await listInboxEntries({ tenantId: 'local', projectId, limit: 1 });
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.workItemId, active.id);
    assert.equal(entries[0]?.attentionState, 'review_ready');
  } finally {
    await getDb().query('DELETE FROM todos WHERE tenant_id=$1 AND project_id=$2', ['local', projectId]);
  }
});

function feedAnalysisEvidence(
  overrides: Partial<Omit<FeedAnalysisWorkItemEvidence, 'callback'>> & {
    callback?: Partial<FeedAnalysisWorkItemEvidence['callback']>;
  } = {},
): FeedAnalysisWorkItemEvidence {
  const { callback: callbackOverrides, ...evidenceOverrides } = overrides;
  return {
    dispatchId: 'dispatch-test',
    sourceSystem: 'lot2extension',
    sourceJobId: 'job-test',
    deliveryMode: 'result_returning' as const,
    dispatchStatus: 'processing' as const,
    resultAvailable: false,
    updatedAt: '2026-07-19T00:00:00.000Z',
    ...evidenceOverrides,
    callback: {
      configured: true,
      latestStatus: 'pending' as const,
      eventCount: 1,
      pendingCount: 1,
      deliveringCount: 0,
      deliveredCount: 0,
      deadLetterCount: 0,
      ...callbackOverrides,
    },
  };
}

test('result acceptance requires succeeded execution, complete verification, and durable diff backup', () => {
  const accepted = acceptanceProjection();
  assert.doesNotThrow(() => _assertResultCanBeAccepted(accepted));
  assertReviewCode(
    () => _assertResultCanBeAccepted({ ...accepted, evidence: { ...accepted.evidence, runSpecStatus: 'running' } }),
    'run_not_succeeded',
  );
  assertReviewCode(
    () => _assertResultCanBeAccepted({
      ...accepted,
      evidence: { ...accepted.evidence, verificationPending: 1 },
    }),
    'verification_incomplete',
  );
  assertReviewCode(
    () => _assertResultCanBeAccepted({
      ...accepted,
      changes: {
        ...accepted.changes,
        workspaces: accepted.changes.workspaces.map(workspace => ({ ...workspace, backupArtifactId: undefined })),
      },
    }),
    'diff_backup_required',
  );
  assertReviewCode(
    () => _assertResultCanBeAccepted({
      ...accepted,
      evidence: {
        ...accepted.evidence,
        verificationRequired: 0,
        verificationSucceeded: 0,
      },
      verificationRecords: [],
    }),
    'verification_required',
  );
});

function acceptanceProjection(): WorkItemProjection {
  const timestamp = '2026-07-19T00:00:00.000Z';
  return {
    id: 'work-review-test',
    title: 'Review test',
    description: 'Review test',
    goal: 'Review test',
    tenantId: 'local',
    projectId: 'los',
    status: 'in_progress',
    priority: 'P1',
    source: 'test',
    runContractDraft: {
      mode: 'execution',
      phase: 'succeeded',
      goal: 'Review test',
      editableSurfaces: ['packages/agent/src/work-items'],
      requiredChecks: ['pnpm --filter @los/agent test'],
      allowedSkippedChecks: [],
      stopConditions: [],
      evidenceRequired: [],
      externalEvidenceAllowed: [],
      rawEvidenceProhibited: [],
    },
    attentionState: 'review_ready',
    nextAction: 'review_changes',
    links: [],
    evidence: {
      latestRunSpecId: 'run-review-test',
      runSpecStatus: 'succeeded',
      verificationRequired: 1,
      verificationSucceeded: 1,
      verificationSkipped: 0,
      verificationFailed: 0,
      verificationPending: 0,
    },
    verificationRecords: [{
      id: 'verification-review-test',
      checkName: 'agent focused tests',
      kind: 'command',
      status: 'succeeded',
      required: true,
      command: 'pnpm --filter @los/agent test',
      updatedAt: timestamp,
      completedAt: timestamp,
    }],
    changes: {
      hasReviewableDiff: true,
      workspaces: [{
        workspaceId: 'workspace-review-test',
        status: 'backup_ready',
        baseRevision: 'base-review-test',
        backupArtifactId: 'artifact-review-test',
        updatedAt: timestamp,
      }],
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function assertReviewCode(action: () => void, code: string): void {
  assert.throws(action, (error: unknown) => (
    error instanceof Error
    && 'code' in error
    && error.code === code
  ));
}
