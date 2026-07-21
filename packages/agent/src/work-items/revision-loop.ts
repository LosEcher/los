import { createHash } from 'node:crypto';

import { withDbClient } from '@los/infra/db';

import { resolveCoordinationBackend } from '../coordination/resolve.js';
import {
  appendSessionEvent,
  ensureSessionEventStore,
  notifySessionEvent,
  type SessionEventRecord,
} from '../session-events.js';
import { createRunSpec, loadRunSpec, reviseRunSpecPlan } from '../run-specs.js';
import { ensureTodoStore, loadTodo, updateTodo } from '../todos.js';
import { listVerificationRecordsForRunSpec } from '../verification-records.js';
import { linkWorkItemRun, listWorkItemRunLinksForRunSpec } from './store.js';
import { loadWorkItemProjection } from './projection.js';
import type { PlanStep, RunContractMetadata } from '../run-contract.js';

const MAX_AUTOMATIC_REVISIONS = 3;

export interface WorkItemRevisionResult {
  workItemId: string;
  runSpecId: string;
  previousRunSpecId: string;
  planRevision: number;
  exhausted: boolean;
  exhaustionReason?: 'retry_budget_exhausted' | 'no_progress';
  attentionEventId?: number;
}

/** Persist one bounded recovery iteration and leave it in planning for approval. */
export async function createWorkItemRevision(input: {
  runSpecId: string;
  reason: string;
  actor?: string;
  trigger: 'verification_failed' | 'revision_requested';
}): Promise<WorkItemRevisionResult> {
  const links = await listWorkItemRunLinksForRunSpec(input.runSpecId);
  const workItemId = links[0]?.workItemId;
  if (!workItemId) throw new Error(`Run spec ${input.runSpecId} is not bound to a Work Item`);
  const coordination = await resolveCoordinationBackend();
  const release = await coordination.lock.acquire(`work-item-revision:${workItemId}`);
  try {
    return await createLockedWorkItemRevision(workItemId, input);
  } finally {
    await release();
  }
}

async function createLockedWorkItemRevision(
  workItemId: string,
  input: {
    runSpecId: string;
    reason: string;
    actor?: string;
    trigger: 'verification_failed' | 'revision_requested';
  },
): Promise<WorkItemRevisionResult> {
  const projection = await loadWorkItemProjection(workItemId);
  if (!projection?.evidence.latestRunSpecId) throw new Error(`Work Item ${workItemId} has no persisted run spec`);
  const current = await loadRunSpec(projection.evidence.latestRunSpecId);
  if (!current?.runContract?.plan?.length) throw new Error(`Run spec ${projection.evidence.latestRunSpecId} has no structured plan`);
  const todo = await loadTodo(workItemId);
  if (!todo) throw new Error(`Work Item ${workItemId} no longer exists`);

  const currentRevision = current.runContract.planRevision ?? 1;
  const feedback = await buildFeedbackState(current.id, currentRevision, current.runContract, input);
  const previousLoop = readRevisionLoop(todo.metadata);
  if (previousLoop?.exhausted && previousLoop.attentionEventId) {
    return exhaustedResult(workItemId, current.id, currentRevision, previousLoop);
  }
  if (
    previousLoop?.feedbackFingerprint === feedback.fingerprint
    && previousLoop.runSpecId === current.id
    && previousLoop.planRevision === currentRevision
  ) {
    if (!feedback.hasNewAttemptEvidence) {
      return {
        workItemId,
        runSpecId: current.id,
        previousRunSpecId: previousLoop.previousRunSpecId ?? current.id,
        planRevision: currentRevision,
        exhausted: false,
      };
    }
    return await exhaustRevisionLoop({
      workItemId,
      current,
      input,
      feedbackFingerprint: feedback.fingerprint,
      exhaustionReason: 'no_progress',
      metadata: todo.metadata,
    });
  }

  const nextRevision = currentRevision + 1;
  if (nextRevision > MAX_AUTOMATIC_REVISIONS) {
    return await exhaustRevisionLoop({
      workItemId,
      current,
      input,
      feedbackFingerprint: feedback.fingerprint,
      exhaustionReason: 'retry_budget_exhausted',
      metadata: todo.metadata,
    });
  }

  const plan = appendRecoveryStep(current.runContract.plan, current.runContract, input.reason, nextRevision);
  const revisionBase = { plan, actor: input.actor ?? 'operator', reason: input.reason };
  const canReviseInPlace = current.runContract.phase === 'blocked'
    || current.runContract.phase === 'planning'
    || current.runContract.phase === 'plan_approved';
  const revised = canReviseInPlace
    ? await reviseRunSpecPlan(current.id, revisionBase)
    : await createChildRevision(current, plan, nextRevision, input);
  const revisedId = revised.id;

  await linkWorkItemRun({ workItemId, runSpecId: revisedId, sessionId: revised.sessionId, relationKind: 'recovery' });
  await updateTodo(workItemId, {
    status: 'in_progress',
    sessionId: revised.sessionId,
    metadata: {
      ...todo.metadata,
      revisionLoop: {
        trigger: input.trigger,
        reason: input.reason,
        feedbackFingerprint: feedback.fingerprint,
        planRevision: nextRevision,
        previousRunSpecId: current.id,
        runSpecId: revisedId,
        exhausted: false,
        updatedAt: new Date().toISOString(),
      },
    },
  });
  await appendSessionEvent({
    sessionId: revised.sessionId,
    tenantId: revised.tenantId,
    projectId: revised.projectId,
    userId: revised.userId,
    requestId: revised.requestId,
    traceId: revised.traceId,
    type: 'run.revision_requested',
    source: 'los.revision-loop',
    payload: { runSpecId: revisedId, previousRunSpecId: current.id, workItemId, trigger: input.trigger, reason: input.reason, planRevision: nextRevision },
  });
  return { workItemId, runSpecId: revisedId, previousRunSpecId: current.id, planRevision: nextRevision, exhausted: false };
}

async function buildFeedbackState(
  runSpecId: string,
  planRevision: number,
  contract: RunContractMetadata,
  input: { reason: string; trigger: 'verification_failed' | 'revision_requested' },
): Promise<{ fingerprint: string; hasNewAttemptEvidence: boolean }> {
  const records = input.trigger === 'verification_failed'
    ? (await listVerificationRecordsForRunSpec(runSpecId, { planRevision }))
      .filter(record => record.required && record.status !== 'succeeded' && record.status !== 'skipped')
    : [];
  const evidence = records.length > 0
    ? records.map(record => [
      record.kind,
      record.checkName,
      record.command ?? '',
      record.assertion ?? '',
      record.reviewer ?? '',
    ].join('\u0000')).sort().join('\u0001')
    : normalizeFeedback(input.reason);
  const phaseShowsAttempt = contract.phase === 'executing'
    || contract.phase === 'verifying'
    || contract.phase === 'blocked'
    || contract.phase === 'succeeded'
    || contract.phase === 'failed';
  return {
    fingerprint: createHash('sha256').update(`${input.trigger}\u0000${evidence}`).digest('hex'),
    hasNewAttemptEvidence: records.some(record => record.status === 'failed')
      || (input.trigger === 'revision_requested' && phaseShowsAttempt),
  };
}

async function exhaustRevisionLoop(input: {
  workItemId: string;
  current: NonNullable<Awaited<ReturnType<typeof loadRunSpec>>>;
  input: { reason: string; trigger: 'verification_failed' | 'revision_requested' };
  feedbackFingerprint: string;
  exhaustionReason: 'retry_budget_exhausted' | 'no_progress';
  metadata: Record<string, unknown>;
}): Promise<WorkItemRevisionResult> {
  await Promise.all([ensureTodoStore(), ensureSessionEventStore()]);
  let insertedEvent: SessionEventRecord | undefined;
  const result = await withDbClient(async (client) => {
    await client.query('BEGIN');
    try {
      const rows = await client.query<{ metadata_json: unknown }>(
        'SELECT metadata_json FROM todos WHERE id = $1 FOR UPDATE',
        [input.workItemId],
      );
      if (!rows.rows[0]) throw new Error(`Work Item ${input.workItemId} no longer exists`);
      const metadata = asRecord(rows.rows[0].metadata_json);
      const existingLoop = readRevisionLoop(metadata);
      if (existingLoop?.attentionEventId) {
        await client.query('COMMIT');
        return exhaustedResult(
          input.workItemId,
          input.current.id,
          input.current.runContract?.planRevision ?? 1,
          existingLoop,
        );
      }

      insertedEvent = await appendSessionEvent({
        sessionId: input.current.sessionId,
        tenantId: input.current.tenantId,
        projectId: input.current.projectId,
        userId: input.current.userId,
        requestId: input.current.requestId,
        traceId: input.current.traceId,
        type: 'run.operator_attention_required',
        source: 'los.revision-loop',
        payload: {
          runSpecId: input.current.id,
          workItemId: input.workItemId,
          trigger: input.input.trigger,
          reason: input.input.reason,
          planRevision: input.current.runContract?.planRevision ?? 1,
          maxAutomaticRevisions: MAX_AUTOMATIC_REVISIONS,
          exhaustionReason: input.exhaustionReason,
          feedbackFingerprint: input.feedbackFingerprint,
        },
      }, { client, notify: false });
      const planRevision = input.current.runContract?.planRevision ?? 1;
      const nextMetadata = {
        ...input.metadata,
        ...metadata,
        revisionLoop: {
          ...(existingLoop ?? {}),
          trigger: input.input.trigger,
          reason: input.input.reason,
          feedbackFingerprint: input.feedbackFingerprint,
          planRevision,
          previousRunSpecId: input.current.id,
          runSpecId: input.current.id,
          exhausted: true,
          exhaustionReason: input.exhaustionReason,
          attentionEventId: insertedEvent.id,
          updatedAt: new Date().toISOString(),
        },
      };
      await client.query(
        'UPDATE todos SET metadata_json = $2::jsonb, updated_at = now() WHERE id = $1',
        [input.workItemId, JSON.stringify(nextMetadata)],
      );
      await client.query('COMMIT');
      return {
        workItemId: input.workItemId,
        runSpecId: input.current.id,
        previousRunSpecId: input.current.id,
        planRevision,
        exhausted: true,
        exhaustionReason: input.exhaustionReason,
        attentionEventId: insertedEvent.id,
      } satisfies WorkItemRevisionResult;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
  if (insertedEvent) await notifySessionEvent(insertedEvent);
  return result;
}

interface RevisionLoopMetadata {
  feedbackFingerprint?: string;
  planRevision?: number;
  previousRunSpecId?: string;
  runSpecId?: string;
  exhausted?: boolean;
  exhaustionReason?: 'retry_budget_exhausted' | 'no_progress';
  attentionEventId?: number;
}

function readRevisionLoop(metadata: Record<string, unknown>): RevisionLoopMetadata | undefined {
  const value = asRecord(metadata.revisionLoop);
  if (Object.keys(value).length === 0) return undefined;
  return {
    feedbackFingerprint: typeof value.feedbackFingerprint === 'string' ? value.feedbackFingerprint : undefined,
    planRevision: typeof value.planRevision === 'number' ? value.planRevision : undefined,
    previousRunSpecId: typeof value.previousRunSpecId === 'string' ? value.previousRunSpecId : undefined,
    runSpecId: typeof value.runSpecId === 'string' ? value.runSpecId : undefined,
    exhausted: value.exhausted === true,
    exhaustionReason: value.exhaustionReason === 'retry_budget_exhausted' || value.exhaustionReason === 'no_progress'
      ? value.exhaustionReason
      : undefined,
    attentionEventId: typeof value.attentionEventId === 'number' ? value.attentionEventId : undefined,
  };
}

function exhaustedResult(
  workItemId: string,
  runSpecId: string,
  planRevision: number,
  metadata: RevisionLoopMetadata,
): WorkItemRevisionResult {
  return {
    workItemId,
    runSpecId,
    previousRunSpecId: metadata.previousRunSpecId ?? runSpecId,
    planRevision,
    exhausted: true,
    exhaustionReason: metadata.exhaustionReason,
    attentionEventId: metadata.attentionEventId,
  };
}

function normalizeFeedback(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function appendRecoveryStep(plan: PlanStep[], contract: RunContractMetadata, reason: string, revision: number): PlanStep[] {
  const id = `recovery-${revision}`;
  const dependencyIds = plan.map(step => step.id);
  return [
    ...plan,
    {
      id,
      title: 'Address verification feedback',
      description: `Resolve the persisted verification or review feedback: ${reason}`,
      dependsOnIds: dependencyIds,
      editableSurfaces: [...new Set(contract.editableSurfaces)],
      completionCriteria: `The feedback is resolved and the required checks pass for revision ${revision}.`,
    },
  ];
}

async function createChildRevision(
  current: NonNullable<Awaited<ReturnType<typeof loadRunSpec>>>,
  plan: PlanStep[],
  revision: number,
  input: { reason: string; actor?: string },
) {
  if (!current.runContract) throw new Error(`Run spec ${current.id} has no run contract`);
  const id = `${current.id}:revision:${revision}`;
  const contract = {
    ...current.runContract,
    phase: 'planning' as const,
    previousPhase: current.runContract.phase,
    plan,
    planRevision: revision,
    planParentRevision: current.runContract.planRevision ?? 1,
    planParentRunSpecId: current.id,
    planHistory: [
      ...(current.runContract.planHistory ?? []),
      {
        revision: current.runContract.planRevision ?? 1,
        plan: current.runContract.plan,
        requiredChecks: current.runContract.requiredChecks,
        verifications: current.runContract.verifications ?? [],
        supersededAt: new Date().toISOString(),
        actor: input.actor,
        reason: input.reason,
      },
    ],
  };
  return await createRunSpec({
    id,
    sessionId: `${current.sessionId}:revision:${revision}`,
    tenantId: current.tenantId,
    projectId: current.projectId,
    userId: current.userId,
    nodeId: current.nodeId,
    requestId: current.requestId,
    traceId: current.traceId,
    prompt: current.prompt,
    systemPrompt: current.systemPrompt,
    provider: current.provider as any,
    model: current.model as any,
    modelSettings: current.modelSettings,
    workspaceRoot: current.workspaceRoot,
    toolMode: current.toolMode,
    allowedTools: current.allowedTools,
    toolRetry: current.toolRetry,
    maxLoops: current.maxLoops,
    timeoutMs: current.timeoutMs,
    mcpServers: current.mcpServers,
    runContract: contract,
  });
}
