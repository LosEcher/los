import { randomUUID } from 'node:crypto';
import { getDb } from '@los/infra/db';
import { loadTaskRun, type TaskRunRecord } from './task-runs.js';
import type { RunSpecRecord } from './run-specs.js';
import {
  deadLetterRowToRecord,
  ensureDeadLetterStore,
  type DeadLetterEventRecord,
  type DeadLetterRow,
  type DLQReason,
} from './dead-letter.js';
import type { ScheduledAgentTaskInput, ScheduledAgentTaskResult } from './scheduler/types.js';

export interface DeadLetterReasonSummary {
  total: number;
  unacknowledged: number;
  acknowledged: number;
  requeued: number;
}

export interface DeadLetterSummary {
  total: number;
  unacknowledged: number;
  acknowledged: number;
  requeued: number;
  requeueEligible: number;
  oldestUnacknowledgedAt: string | null;
  byReason: Record<DLQReason, DeadLetterReasonSummary>;
}

export type DeadLetterRequeueResult =
  | { status: 'requeued'; event: DeadLetterEventRecord; taskRunId: string }
  | { status: 'not_eligible' | 'already_requeued' | 'not_found'; event?: DeadLetterEventRecord; reason: string };

export interface DeadLetterRequeueOptions {
  scheduler?: (input: ScheduledAgentTaskInput) => Promise<ScheduledAgentTaskResult | void>;
}

export async function summarizeDeadLetterEvents(): Promise<DeadLetterSummary> {
  await ensureDeadLetterStore();
  const rows = await getDb().query<DeadLetterSummaryRow>(
    `SELECT reason,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE acknowledged_at IS NULL)::int AS unacknowledged,
            COUNT(*) FILTER (WHERE acknowledged_at IS NOT NULL)::int AS acknowledged,
            COUNT(*) FILTER (WHERE requeued_task_run_id IS NOT NULL)::int AS requeued,
            COUNT(*) FILTER (WHERE reason = 'lease_expired' AND acknowledged_at IS NULL AND requeued_task_run_id IS NULL)::int AS eligible,
            MIN(created_at) FILTER (WHERE acknowledged_at IS NULL) AS oldest_unacknowledged_at
     FROM dead_letter_events
     GROUP BY reason
     ORDER BY reason`,
  );
  const byReason = emptyReasonSummary();
  let oldest: string | null = null;
  let total = 0;
  let unacknowledged = 0;
  let acknowledged = 0;
  let requeued = 0;
  let requeueEligible = 0;
  for (const row of rows.rows) {
    if (!isDLQReason(row.reason)) continue;
    byReason[row.reason] = { total: row.total, unacknowledged: row.unacknowledged, acknowledged: row.acknowledged, requeued: row.requeued };
    total += row.total;
    unacknowledged += row.unacknowledged;
    acknowledged += row.acknowledged;
    requeued += row.requeued;
    requeueEligible += row.eligible;
    if (row.oldest_unacknowledged_at && (!oldest || new Date(row.oldest_unacknowledged_at).getTime() < new Date(oldest).getTime())) {
      oldest = toIsoString(row.oldest_unacknowledged_at);
    }
  }
  return { total, unacknowledged, acknowledged, requeued, requeueEligible, oldestUnacknowledgedAt: oldest, byReason };
}

export async function requeueDeadLetterEvent(
  id: string,
  options: DeadLetterRequeueOptions = {},
): Promise<DeadLetterRequeueResult> {
  await ensureDeadLetterStore();
  const existing = await loadDeadLetterEvent(id);
  if (!existing) return { status: 'not_found', reason: 'dead_letter_event_not_found' };
  if (existing.requeuedTaskRunId) return { status: 'already_requeued', event: existing, reason: 'already_requeued' };
  if (existing.reason !== 'lease_expired') return { status: 'not_eligible', event: existing, reason: 'reason_not_retryable' };
  if (!existing.runSpecId) return { status: 'not_eligible', event: existing, reason: 'run_spec_missing' };

  const [{ loadRunSpec }, task] = await Promise.all([
    import('./run-specs.js'),
    existing.taskRunId ? loadTaskRun(existing.taskRunId) : Promise.resolve(null),
  ]);
  const runSpec = await loadRunSpec(existing.runSpecId);
  if (!runSpec) return { status: 'not_eligible', event: existing, reason: 'run_spec_not_found' };
  if (typeof task?.metadata.agentTaskId === 'string') {
    return { status: 'not_eligible', event: existing, reason: 'agent_task_graph_manages_recovery' };
  }
  if (['succeeded', 'failed', 'cancelled'].includes(runSpec.status)) {
    return { status: 'not_eligible', event: existing, reason: `run_spec_${runSpec.status}` };
  }

  const taskRunId = `task-retry-${randomUUID()}`;
  const claim = await getDb().query<DeadLetterRow>(
    `UPDATE dead_letter_events
     SET requeued_task_run_id = $2, requeued_at = now(), acknowledged_at = COALESCE(acknowledged_at, now()), requeue_error = NULL
     WHERE id = $1 AND reason = 'lease_expired' AND requeued_task_run_id IS NULL
     RETURNING *`,
    [id, taskRunId],
  );
  if (!claim.rows[0]) {
    const current = await loadDeadLetterEvent(id);
    return current?.requeuedTaskRunId
      ? { status: 'already_requeued', event: current, reason: 'already_requeued' }
      : { status: 'not_eligible', event: current ?? existing, reason: 'requeue_claim_failed' };
  }

  try {
    const { transitionExecutionState } = await import('./execution-store.js');
    if (runSpec.status !== 'running') {
      await transitionExecutionState({
        entityType: 'run_spec', entityId: runSpec.id, to: 'running', sessionId: runSpec.sessionId,
        reason: `dead_letter_requeue:${id}`, nodeId: task?.nodeId,
      });
    }
    const input = buildRetryInput(id, taskRunId, runSpec, task);
    const scheduler = options.scheduler ?? (await import('./scheduler/scheduled-task-runner.js')).runScheduledAgentTask;
    const scheduled = scheduler(input);
    void scheduled.then(async (result) => {
      try {
        if (result) await finalizeRequeuedRunSpec(runSpec.id, result);
        await recordRequeueError(id, null);
      } catch (error) {
        await recordRequeueError(id, `run_spec_finalize_failed:${error instanceof Error ? error.message : String(error)}`);
      }
    }).catch(async (error: unknown) => {
      await finalizeRequeuedRunSpec(runSpec.id, null, error).catch(() => undefined);
      await recordRequeueError(id, error instanceof Error ? error.message : String(error));
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await releaseRequeueClaim(id, message);
    return { status: 'not_eligible', event: await loadDeadLetterEvent(id) ?? existing, reason: `schedule_failed:${message}` };
  }
  return { status: 'requeued', event: deadLetterRowToRecord(claim.rows[0]), taskRunId };
}

function buildRetryInput(
  eventId: string,
  taskRunId: string,
  runSpec: RunSpecRecord,
  task: TaskRunRecord | null,
): ScheduledAgentTaskInput {
  return {
    taskRunId, attempt: (task?.attempt ?? 1) + 1, sessionId: runSpec.sessionId, runSpecId: runSpec.id,
    traceId: runSpec.traceId ?? task?.traceId ?? taskRunId, requestId: runSpec.requestId ?? task?.requestId,
    tenantId: runSpec.tenantId ?? task?.tenantId, projectId: runSpec.projectId ?? task?.projectId,
    userId: runSpec.userId ?? task?.userId, workspaceRoot: runSpec.workspaceRoot,
    toolMode: runSpec.toolMode as ScheduledAgentTaskInput['toolMode'], prompt: runSpec.prompt,
    promptPreview: task?.promptPreview ?? runSpec.prompt.slice(0, 200), systemPrompt: runSpec.systemPrompt,
    provider: runSpec.provider, model: runSpec.model, modelSettings: runSpec.modelSettings,
    maxLoops: runSpec.maxLoops, timeoutMs: runSpec.timeoutMs, allowedTools: runSpec.allowedTools,
    toolRetry: runSpec.toolRetry as ScheduledAgentTaskInput['toolRetry'], mcpServers: runSpec.mcpServers,
    runContract: runSpec.runContract,
    metadata: { ...(task?.metadata ?? {}), deadLetterRetry: { eventId, sourceTaskRunId: task?.id ?? null, queuedAt: new Date().toISOString() } },
  };
}

async function loadDeadLetterEvent(id: string): Promise<DeadLetterEventRecord | null> {
  const rows = await getDb().query<DeadLetterRow>('SELECT * FROM dead_letter_events WHERE id = $1', [id]);
  return rows.rows[0] ? deadLetterRowToRecord(rows.rows[0]) : null;
}

async function recordRequeueError(id: string, error: string | null): Promise<void> {
  await getDb().query('UPDATE dead_letter_events SET requeue_error = $2 WHERE id = $1', [id, error]).catch(() => undefined);
}

async function releaseRequeueClaim(id: string, error: string): Promise<void> {
  await getDb().query(
    `UPDATE dead_letter_events
     SET requeued_task_run_id = NULL, requeued_at = NULL, acknowledged_at = NULL, requeue_error = $2
     WHERE id = $1`,
    [id, error],
  ).catch(() => undefined);
}

async function finalizeRequeuedRunSpec(
  runSpecId: string,
  result: ScheduledAgentTaskResult | null,
  failure?: unknown,
): Promise<void> {
  const [{ loadRunSpec }, { transitionExecutionState }] = await Promise.all([
    import('./run-specs.js'),
    import('./execution-store.js'),
  ]);
  const current = await loadRunSpec(runSpecId);
  if (!current || ['succeeded', 'failed', 'cancelled'].includes(current.status)) return;
  const reason = failure instanceof Error ? failure.message : failure ? String(failure) : `dead_letter_retry:${result?.status ?? 'failed'}`;
  if (failure) {
    await transitionExecutionState({ entityType: 'run_spec', entityId: runSpecId, to: 'failed', sessionId: current.sessionId, reason });
    return;
  }
  if (result?.status === 'cancelled') {
    await transitionExecutionState({ entityType: 'run_spec', entityId: runSpecId, to: 'cancelled', sessionId: current.sessionId, reason: result.reason });
    return;
  }
  if (result?.status !== 'completed') {
    await transitionExecutionState({ entityType: 'run_spec', entityId: runSpecId, to: 'blocked', sessionId: current.sessionId, reason });
    return;
  }
  const { ensureRunSpecVerificationPhase } = await import('./run-phase-transitions.js');
  await ensureRunSpecVerificationPhase(runSpecId, 'dead_letter_retry_completed', 'los.dead_letter');
  try {
    await transitionExecutionState({ entityType: 'run_spec', entityId: runSpecId, to: 'succeeded', sessionId: current.sessionId, reason });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'RunSuccessGateError') throw error;
    await transitionExecutionState({ entityType: 'run_spec', entityId: runSpecId, to: 'blocked', sessionId: current.sessionId, reason: error.message });
  }
}

function isDLQReason(value: string): value is DLQReason {
  return value === 'lease_expired' || value === 'max_attempts' || value === 'unrecoverable_error';
}

function emptyReasonSummary(): Record<DLQReason, DeadLetterReasonSummary> {
  return {
    lease_expired: { total: 0, unacknowledged: 0, acknowledged: 0, requeued: 0 },
    max_attempts: { total: 0, unacknowledged: 0, acknowledged: 0, requeued: 0 },
    unrecoverable_error: { total: 0, unacknowledged: 0, acknowledged: 0, requeued: 0 },
  };
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

type DeadLetterSummaryRow = {
  reason: string;
  total: number;
  unacknowledged: number;
  acknowledged: number;
  requeued: number;
  eligible: number;
  oldest_unacknowledged_at: Date | string | null;
};
