import { getLogger } from '@los/infra/logger';

import { listExecutorNodes } from '../executor-nodes.js';
import { dispatchFeedAnalysisJob } from '../integration/feed-analysis-ingress.js';
import type { FeedAnalysisDispatchRequest } from '../integration/feed-analysis-types.js';
import { listServiceInstances } from '../service-instances.js';
import { createTodo } from '../todos.js';
import { listInboxEntries } from '../work-items/projection.js';
import {
  attachScheduledRunWorkItem, attachScheduleRecoveryWorkItem,
  claimDueScheduledWorkItems, claimQueuedScheduledWorkRuns,
  createManualScheduledWorkRun, loadScheduledWorkItem, loadScheduledWorkItemRun,
  recordScheduledRunOutcome, recoverExpiredScheduledWorkRuns,
  transitionScheduledWorkRun,
} from './store.js';
import type { ScheduledWorkItem, ScheduledWorkItemRun, ScheduledWorkRunOutcome } from './types.js';

const log = getLogger('scheduled-work');

export interface ScheduledWorkTickResult {
  claimed: number;
  recovered: number;
  exhausted: number;
  succeeded: number;
  noOps: number;
  awaitingApproval: number;
  failed: number;
  runIds: string[];
}

export async function runScheduledWorkTick(input: {
  ownerId: string; now?: Date; leaseMs?: number; limit?: number;
}): Promise<ScheduledWorkTickResult> {
  const recovery = await recoverExpiredScheduledWorkRuns(input);
  for (const exhausted of recovery.exhausted) {
    await recordScheduledRunOutcome({ scheduleId: exhausted.scheduleId, status: 'failed' });
  }
  const [due, queued] = await Promise.all([
    claimDueScheduledWorkItems(input),
    claimQueuedScheduledWorkRuns(input),
  ]);
  const runs = [...recovery.recovered, ...due.filter(run => run.status === 'claimed'), ...queued];
  const result: ScheduledWorkTickResult = {
    claimed: due.length + queued.length,
    recovered: recovery.recovered.length,
    exhausted: recovery.exhausted.length,
    succeeded: 0, noOps: 0, awaitingApproval: 0, failed: recovery.exhausted.length,
    runIds: [...recovery.exhausted, ...runs].map(run => run.id),
  };
  for (const run of runs) {
    const status = await executeScheduledWorkRun(run);
    if (status === 'succeeded') result.succeeded += 1;
    else if (status === 'no_op') result.noOps += 1;
    else if (status === 'awaiting_approval') result.awaitingApproval += 1;
    else result.failed += 1;
  }
  return result;
}

export async function triggerScheduledWorkItem(input: {
  scheduleId: string; ownerId: string; scheduledFor?: Date;
}): Promise<ScheduledWorkItemRun> {
  const run = await createManualScheduledWorkRun(input);
  await executeScheduledWorkRun(run);
  return (await loadScheduledWorkItemRun(run.id))!;
}

export async function executeScheduledWorkRun(
  run: ScheduledWorkItemRun,
): Promise<'succeeded' | 'no_op' | 'awaiting_approval' | 'failed'> {
  const schedule = await loadScheduledWorkItem(run.scheduleId);
  if (!schedule) throw new Error('schedule disappeared before execution');
  const feedAnalysisPreapproved = schedule.runTemplate.templateId === 'scheduled_feed_analysis'
    && schedule.approvalPolicy === 'preapproved_scope';
  if (schedule.approvalPolicy !== 'read_only_auto' && !feedAnalysisPreapproved) {
    const workItemId = await createScheduleWorkItem(schedule, run, 'awaiting_approval', {
      approvalPolicy: schedule.approvalPolicy,
      message: 'This schedule requires operator approval for each execution.',
    });
    await transitionScheduledWorkRun(run.id, 'awaiting_approval', { workItemId });
    return 'awaiting_approval';
  }
  await transitionScheduledWorkRun(run.id, 'running', {
    ownerId: run.claimOwner,
    leaseExpiresAt: run.leaseExpiresAt ? new Date(run.leaseExpiresAt) : undefined,
  });
  try {
    const outcome = await executeTemplate(schedule, run);
    const completed = await transitionScheduledWorkRun(run.id, outcome.status, {
      resultSummary: outcome.summary,
      workItemId: outcome.workItemId,
      runSpecId: outcome.runSpecId,
      taskRunId: outcome.taskRunId,
    });
    const updated = await recordScheduledRunOutcome({ scheduleId: schedule.id, status: outcome.status });
    if (outcome.status === 'succeeded' && !outcome.workItemId) {
      const workItemId = await createScheduleWorkItem(updated.schedule, completed, 'succeeded', outcome.summary, outcome.title);
      await attachScheduledRunWorkItem(run.id, workItemId);
    }
    return outcome.status;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await transitionScheduledWorkRun(run.id, 'failed', { error: message });
    const updated = await recordScheduledRunOutcome({ scheduleId: schedule.id, status: 'failed' });
    if (updated.circuitOpened) {
      const workItemId = await createScheduleWorkItem(updated.schedule, run, 'failed', {
        error: message,
        circuitState: 'open',
        consecutiveFailures: updated.schedule.consecutiveFailures,
      }, `${schedule.title}: recovery required`);
      await attachScheduleRecoveryWorkItem(schedule.id, workItemId);
      await attachScheduledRunWorkItem(run.id, workItemId);
    }
    log.warn(`Scheduled work failed for ${schedule.id}: ${message}`);
    return 'failed';
  }
}

export function setupScheduledWorkWake(input: {
  ownerId: string; intervalMs?: number;
}): () => void {
  const intervalMs = Math.max(5_000, input.intervalMs ?? 30_000);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runScheduledWorkTick({ ownerId: input.ownerId });
      if (result.runIds.length > 0) log.info(`Scheduled work processed ${result.runIds.length} run(s)`);
    } catch (error) {
      log.warn(`Scheduled work tick failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  };
  const timeout = setTimeout(tick, 2_000);
  const timer = setInterval(tick, intervalMs);
  return () => { clearTimeout(timeout); clearInterval(timer); };
}

async function executeTemplate(
  schedule: ScheduledWorkItem,
  run: ScheduledWorkItemRun,
): Promise<ScheduledWorkRunOutcome> {
  if (schedule.runTemplate.templateId === 'scheduled_feed_analysis') {
    const derived = _deriveScheduledFeedAnalysisDispatch(schedule, run);
    const result = await dispatchFeedAnalysisJob(derived.request, derived.idempotencyKey, {
      workspaceRoot: process.cwd(),
      tenantId: schedule.tenantId,
      projectId: schedule.projectId,
      userId: schedule.userId,
      requestId: run.id,
      maxInlineBytes: 1024 * 1024,
      maxItems: 500,
      materialHosts: [],
      materialFetchTimeoutMs: 10_000,
    });
    return {
      status: 'succeeded',
      title: `${schedule.title}: dispatch accepted`,
      summary: {
        accepted: result.dispatchState.accepted,
        dispatchId: result.dispatch.id,
        dispatchStatus: result.dispatch.status,
        workItemId: result.dispatch.workItemId,
        runSpecId: result.dispatch.runId,
        resultAvailable: result.dispatchState.resultAvailable,
        callbackComplete: false,
      },
      workItemId: result.dispatch.workItemId,
      runSpecId: result.dispatch.runId,
    };
  }
  if (schedule.runTemplate.templateId === 'morning_inbox_digest') {
    const entries = await listInboxEntries({ projectId: schedule.projectId, limit: 100 });
    if (entries.length === 0) return { status: 'no_op', summary: { inboxCount: 0 } };
    const byAttention = entries.reduce<Record<string, number>>((counts, entry) => {
      counts[entry.attentionState] = (counts[entry.attentionState] ?? 0) + 1;
      return counts;
    }, {});
    return {
      status: 'succeeded',
      title: `${schedule.title}: ${entries.length} item${entries.length === 1 ? '' : 's'} need attention`,
      summary: { inboxCount: entries.length, byAttention },
    };
  }
  const [nodes, services] = await Promise.all([listExecutorNodes(), listServiceInstances()]);
  const unavailableNodes = nodes.filter(node => node.status !== 'online');
  const unavailableServices = services.filter(service => service.status !== 'online');
  if (unavailableNodes.length === 0 && unavailableServices.length === 0) {
    return { status: 'no_op', summary: { nodes: nodes.length, services: services.length, unavailable: 0 } };
  }
  return {
    status: 'succeeded',
    title: `${schedule.title}: runtime attention required`,
    summary: {
      nodes: nodes.length, services: services.length,
      unavailableNodes: unavailableNodes.map(node => node.nodeId),
      unavailableServices: unavailableServices.map(service => service.serviceId),
    },
  };
}

export function _deriveScheduledFeedAnalysisDispatch(
  schedule: ScheduledWorkItem,
  run: ScheduledWorkItemRun,
): { request: FeedAnalysisDispatchRequest; idempotencyKey: string } {
  if (schedule.runTemplate.templateId !== 'scheduled_feed_analysis') {
    throw new Error('schedule is not a scheduled_feed_analysis template');
  }
  if (schedule.approvalPolicy !== 'preapproved_scope') {
    throw new Error('scheduled_feed_analysis requires preapproved_scope');
  }
  const template = schedule.runTemplate.feedAnalysisRequest;
  if (!template) throw new Error('scheduled feed analysis request is missing');
  const stableSlot = new Date(run.scheduledFor).toISOString();
  const sourceJobId = `los-schedule:${schedule.id}:${stableSlot}`;
  return {
    request: {
      ...template,
      sourceJobId,
      metadata: {
        ...template.metadata,
        scheduledWork: {
          scheduleId: schedule.id,
          runId: run.id,
          scheduledFor: stableSlot,
          revision: schedule.revision,
        },
      },
    },
    idempotencyKey: `scheduled-feed-analysis:${schedule.id}:${stableSlot}`,
  };
}

async function createScheduleWorkItem(
  schedule: ScheduledWorkItem,
  run: ScheduledWorkItemRun,
  scheduledStatus: 'awaiting_approval' | 'succeeded' | 'failed',
  summary: Record<string, unknown>,
  title = schedule.title,
): Promise<string> {
  const todo = await createTodo({
    tenantId: schedule.tenantId, projectId: schedule.projectId, userId: schedule.userId,
    title, description: schedule.runTemplate.goalTemplate, kind: 'task', status: 'backlog', priority: 'P2',
    source: 'scheduled-work',
    dedupeKey: scheduledStatus === 'failed'
      ? `schedule-circuit:${schedule.id}:revision:${schedule.revision}`
      : `schedule-run-result:${run.id}`,
    runContract: {
      mode: schedule.runTemplate.mode,
      phase: scheduledStatus === 'awaiting_approval' ? 'planning' : scheduledStatus === 'failed' ? 'blocked' : 'succeeded',
      goal: schedule.runTemplate.goalTemplate, editableSurfaces: [],
      requiredChecks: schedule.runTemplate.requiredChecks, stopConditions: ['operator cancels schedule'],
      evidenceRequired: ['scheduled work run record'], toolMode: 'read-only',
      externalEvidenceAllowed: [], rawEvidenceProhibited: [],
    },
    metadata: {
      createdFrom: 'scheduled-work-runner',
      scheduledWork: { scheduleId: schedule.id, runId: run.id, status: scheduledStatus, summary },
    },
  });
  return todo.id;
}
