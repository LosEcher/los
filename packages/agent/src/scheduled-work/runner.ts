import { getLogger } from '@los/infra/logger';
import { getDb } from '@los/infra/db';
import { listManagedWorkspaces } from '../managed-workspace-store.js';

import { listExecutorNodes } from '../executor-nodes.js';
import { dispatchFeedAnalysisJob } from '../integration/feed-analysis-ingress.js';
import type { FeedAnalysisDispatchRequest } from '../integration/feed-analysis-types.js';
import {
  getAllCachedProbeResults,
  probeProviders,
  resolveConfiguredProbeTargets,
  startProviderProbeLoop,
  stopProviderProbeLoop,
} from '../providers/provider-probe.js';
import { runScheduledAgentTask } from '../scheduler.js';
import { appendSessionEvent } from '../session-events.js';
import { listServiceInstances } from '../service-instances.js';
import { createTodo } from '../todos.js';
import { listInboxEntries } from '../work-items/projection.js';
import {
  startScheduledWorkExecutionHeartbeat,
  waitForAdoptedScheduleTask,
} from './execution-lease.js';
import { defaultScheduledWorkExecutionLeaseMs } from './lease.js';
import { recoverExpiredScheduledWorkRuns } from './recovery.js';
import {
  attachScheduledRunWorkItem, attachScheduleRecoveryWorkItem,
  claimDueScheduledWorkItems, claimQueuedScheduledWorkRuns,
  createCatchUpScheduledWorkRun, createManualScheduledWorkRun,
  findMissedScheduledRun,
  loadScheduledWorkItem, loadScheduledWorkItemRun,
  recoverOpenScheduledWorkCircuits,
  recordScheduledRunOutcome,
  transitionScheduledWorkRun,
} from './store.js';
import type { ScheduledWorkItem, ScheduledWorkItemRun, ScheduledWorkRunOutcome } from './types.js';

const log = getLogger('scheduled-work');
const TERMINAL_SCHEDULED_RUN = new Set(['succeeded', 'no_op', 'failed', 'cancelled', 'skipped']);

async function resolveWorkspaceRoot(projectId: string): Promise<string> {
  try {
    const workspaces = await listManagedWorkspaces({ projectId, status: 'active', limit: 1 });
    if (workspaces.length > 0 && workspaces[0]!.workspaceRoot) {
      return workspaces[0]!.workspaceRoot;
    }
  } catch {
    // Fall through to cwd if managed-workspace lookup fails
  }
  return process.cwd();
}

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
  // Approval timeout sweep: awaiting_approval runs whose wait exceeded the
  // schedule's approvalTimeoutMs are auto-disposed (deny by default, approve
  // when the schedule opts in). Runs transition atomically so concurrent
  // gateway instances cannot double-dispose.
  const expired = await expireAwaitingApprovalRuns({ ownerId: input.ownerId, now: input.now });
  if (expired.autoApproved.length > 0 || expired.autoDenied.length > 0) {
    log.info(`Scheduled work approval timeout disposed ${expired.autoApproved.length} approved / ${expired.autoDenied.length} denied run(s)`);
  }
  const recoveredCircuits = await recoverOpenScheduledWorkCircuits(input);
  if (recoveredCircuits.length > 0) {
    log.info(`Scheduled work circuit recovered ${recoveredCircuits.length} open schedule(s) to half_open for a probe run`);
  }
  const recovery = await recoverExpiredScheduledWorkRuns(input);
  for (const exhausted of recovery.exhausted) {
    const updated = await recordScheduledRunOutcome({ scheduleId: exhausted.scheduleId, status: 'failed' });
    if (updated.circuitOpened) {
      // Same operator notification as an execution failure at the threshold:
      // a lease-exhausted run opening the circuit must surface a recovery item.
      const workItemId = await createScheduleWorkItem(updated.schedule, exhausted, 'failed', {
        error: exhausted.error ?? 'lease expired and retry limit exhausted',
        circuitState: 'open',
        consecutiveFailures: updated.schedule.consecutiveFailures,
      }, `${updated.schedule.title}: recovery required`);
      await attachScheduleRecoveryWorkItem(exhausted.scheduleId, workItemId);
    }
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
  // preapproved_scope means the operator already authorized the schedule's
  // scope at create/update time. Only each_run requires a per-execution wait.
  // (2026-08-09: network-observe/surge/NAS spent days cancelling on
  // approval_timeout because preapproved_scope incorrectly still waited.)
  const scopePreapproved = schedule.approvalPolicy === 'preapproved_scope';
  // A run that was explicitly approved (approveScheduledWorkRun marks it with
  // resultSummary.approvedBy and queues it) is allowed through; anything else
  // under a non-auto approval policy must wait for operator approval.
  const approved = run.resultSummary?.approvedBy !== undefined;
  if (schedule.approvalPolicy !== 'read_only_auto' && !scopePreapproved && !approved) {
    const workItemId = await createScheduleWorkItem(schedule, run, 'awaiting_approval', {
      approvalPolicy: schedule.approvalPolicy,
      message: 'This schedule requires operator approval for each execution.',
    });
    await transitionScheduledWorkRun(run.id, 'awaiting_approval', { workItemId });
    // P0-1: surface the approval request through the operator attention event
    // stream. SSE consumers (/operator/events/live, wechat-bot, telegram-bot)
    // pick up run.operator_attention_required automatically, so the operator
    // is notified instead of the run silently waiting for approval.
    try {
      await appendSessionEvent({
        sessionId: `scheduled:${run.id}`,
        type: 'run.operator_attention_required',
        source: 'scheduled-work',
        payload: {
          event: 'scheduled_run_approval_required',
          scheduleId: schedule.id,
          scheduleTitle: schedule.title,
          runId: run.id,
          workItemId,
          scheduledFor: run.scheduledFor,
          reason: `定时任务「${schedule.title}」等待审批 (scheduled ${run.scheduledFor})`,
          entityId: run.id,
          entityType: 'scheduled_work_run',
        },
      });
    } catch (error) {
      // Notification is best-effort; never block the approval transition.
      log.warn(`scheduled approval notification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 'awaiting_approval';
  }
  // Long agent work needs an execution lease well beyond the short claim lease,
  // plus heartbeats so the tick reaper does not reclaim mid-flight.
  const executionLeaseMs = defaultScheduledWorkExecutionLeaseMs();
  await transitionScheduledWorkRun(run.id, 'running', {
    ownerId: run.claimOwner ?? undefined,
    leaseExpiresAt: new Date(Date.now() + executionLeaseMs),
  });
  const stopHeartbeat = startScheduledWorkExecutionHeartbeat({
    runId: run.id,
    ownerId: run.claimOwner,
    leaseMs: executionLeaseMs,
  });
  try {
    const outcome = await executeTemplate(schedule, run);
    let completed: ScheduledWorkItemRun;
    try {
      completed = await transitionScheduledWorkRun(run.id, outcome.status, {
        // Merge with the existing result summary so approval markers
        // (approvedBy) survive execution (2026-08-07 regression: outcome
        // summary overwrote the approval record).
        resultSummary: { ...(run.resultSummary ?? {}), ...outcome.summary },
        workItemId: outcome.workItemId,
        runSpecId: outcome.runSpecId,
        taskRunId: outcome.taskRunId,
      });
    } catch {
      // Dual-owner race: original + adopted reclaim both try to terminalize.
      const raced = await loadScheduledWorkItemRun(run.id);
      if (raced && (raced.status === 'succeeded' || raced.status === 'no_op')) return raced.status;
      if (raced && TERMINAL_SCHEDULED_RUN.has(raced.status)) return 'failed';
      throw new Error('scheduled work run changed concurrently while completing');
    }
    const updated = await recordScheduledRunOutcome({ scheduleId: schedule.id, status: outcome.status });
    if (outcome.status === 'succeeded' && !outcome.workItemId) {
      const workItemId = await createScheduleWorkItem(updated.schedule, completed, 'succeeded', outcome.summary, outcome.title);
      await attachScheduledRunWorkItem(run.id, workItemId);
    }
    return outcome.status;
  } catch (error) {
    // Another owner (or a racing original) may already have terminalized the run.
    // Do not overwrite a real success with a false failure from a late reclaim.
    const current = await loadScheduledWorkItemRun(run.id);
    if (current && TERMINAL_SCHEDULED_RUN.has(current.status)) {
      if (current.status === 'succeeded' || current.status === 'no_op') return current.status;
      return 'failed';
    }
    const message = error instanceof Error ? error.message : String(error);
    try {
      await transitionScheduledWorkRun(run.id, 'failed', { error: message });
    } catch {
      const raced = await loadScheduledWorkItemRun(run.id);
      if (raced && (raced.status === 'succeeded' || raced.status === 'no_op')) return raced.status;
      return 'failed';
    }
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
  } finally {
    stopHeartbeat();
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
  // ADR 0031: start provider health probe cadence alongside scheduler wake.
  // Warm-up one cycle immediately so routing has cache data before the first timer.
  startProviderProbeLoop();
  void probeProviders(resolveConfiguredProbeTargets())
    .then((probes) => {
      if (probes.length > 0) {
        log.info(`Provider probe warm-up: ${probes.length} target(s), cache=${getAllCachedProbeResults().length}`);
      }
    })
    .catch((error) => {
      log.warn(`Provider probe warm-up failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  return () => {
    clearTimeout(timeout);
    clearInterval(timer);
    stopProviderProbeLoop();
  };
}

async function executeTemplate(
  schedule: ScheduledWorkItem,
  run: ScheduledWorkItemRun,
): Promise<ScheduledWorkRunOutcome> {
  if (schedule.runTemplate.templateId === 'scheduled_feed_analysis') {
    const derived = _deriveScheduledFeedAnalysisDispatch(schedule, run);
    const result = await dispatchFeedAnalysisJob(derived.request, derived.idempotencyKey, {
      workspaceRoot: await resolveWorkspaceRoot(schedule.projectId),
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
  if (schedule.runTemplate.templateId === 'daily_execution_digest') {
    const { publishDailyDigest } = await import('../daily-digest.js');
    const published = await publishDailyDigest(
      { projectId: schedule.projectId, tenantId: schedule.tenantId },
      { scheduleId: schedule.id, runId: run.id },
    );
    return {
      status: 'succeeded',
      title: `${schedule.title}: day=${published.digest.day}`,
      summary: {
        day: published.digest.day,
        eventEmitted: published.eventEmitted,
        enabledCount: published.digest.schedule.enabledCount,
        runTotals: published.digest.schedule.runTotals,
        highlightCount: published.digest.highlights.length,
      },
    };
  }
  if (schedule.runTemplate.templateId === 'scheduled_execution') {
    const dedupeKey = `schedule-exec-${run.id}`;
    const disposition = schedule.runTemplate.mode === 'execution' ? 'execution' as const : 'planning' as const;
    const result = await runScheduledAgentTask({
      prompt: schedule.runTemplate.goalTemplate,
      workspaceRoot: schedule.runTemplate.workspaceRoot
        ?? await resolveWorkspaceRoot(schedule.projectId),
      tenantId: schedule.tenantId,
      projectId: schedule.projectId,
      userId: schedule.userId,
      toolMode: schedule.runTemplate.toolMode,
      sandboxMode: schedule.runTemplate.sandboxMode,
      disposition,
      dedupeKey,
      runSpecId: run.runSpecId,
      executor: schedule.runTemplate.executor,
      maxLoops: schedule.runTemplate.maxLoops,
      metadata: {
        scheduledWork: {
          scheduleId: schedule.id,
          runId: run.id,
          scheduledFor: run.scheduledFor,
          templateId: 'scheduled_execution',
          revision: schedule.revision,
        },
      },
      runContract: {
        mode: schedule.runTemplate.mode,
        goal: schedule.runTemplate.goalTemplate,
        editableSurfaces: schedule.runTemplate.editableSurfaces,
        requiredChecks: schedule.runTemplate.requiredChecks,
        stopConditions: ['operator cancels schedule'],
      },
    });
    if (result.status === 'completed') {
      return {
        status: 'succeeded',
        title: `${schedule.title}: execution completed`,
        summary: {
          sessionId: result.sessionId,
          taskRunId: result.taskRun?.id,
          runSpecId: result.taskRun?.runSpecId,
          loopCount: result.result?.loopCount,
          promptTokens: result.result?.totalTokens?.prompt,
          completionTokens: result.result?.totalTokens?.completion,
        },
        runSpecId: result.taskRun?.runSpecId,
        taskRunId: result.taskRun?.id,
      };
    }
    // Same-run dedupe key means the original attempt is still the owner of the
    // agent work. Adopt its terminal outcome instead of failing the schedule
    // run with "Scheduled execution deduplicated" while the first task succeeds.
    if (result.status === 'deduplicated') {
      const adopted = await waitForAdoptedScheduleTask(
        result.taskRun,
        defaultScheduledWorkExecutionLeaseMs(),
      );
      if (adopted.status === 'succeeded') {
        return {
          status: 'succeeded',
          title: `${schedule.title}: execution completed (adopted)`,
          summary: {
            adopted: true,
            sessionId: result.sessionId,
            taskRunId: adopted.id,
            runSpecId: adopted.runSpecId,
          },
          runSpecId: adopted.runSpecId,
          taskRunId: adopted.id,
        };
      }
      throw new Error(
        `Scheduled execution adopted task ${adopted.status}${adopted.id ? ` (${adopted.id})` : ''}`,
      );
    }
    // blocked / cancelled / failed → surface as run failure for circuit breaker
    const reason = 'reason' in result ? (result as { reason?: string }).reason : result.status;
    throw new Error(`Scheduled execution ${result.status}${reason ? `: ${reason}` : ''}`);
  }
  const [nodes, services] = await Promise.all([listExecutorNodes(), listServiceInstances()]);
  // Named fleet (LOS_FLEET_NODE_IDS) + consecutive-tick attention events.
  const { tickNamedFleetWatch } = await import('../fleet-inventory.js');
  const fleetTick = await tickNamedFleetWatch(nodes, {
    tenantId: schedule.tenantId,
    projectId: schedule.projectId,
    scheduleId: schedule.id,
    runId: run.id,
  });
  const fleetSnap = fleetTick.snapshot;
  // Active gateways only: not ready, or online without readiness, count as attention.
  // Historical offline gateway rows (old ports) are noise and no longer listed.
  const unavailableServices = services.filter(service => {
    if (service.serviceKind !== 'gateway') return false;
    if (service.status === 'online') return service.readiness?.ready !== true;
    // Offline gateway is attention only when it still has a recent heartbeat (< 24h).
    const hb = Date.parse(service.lastHeartbeatAt ?? '');
    return Number.isFinite(hb) && Date.now() - hb < 24 * 60 * 60_000;
  });
  if (fleetSnap.attentionNodeIds.length === 0 && unavailableServices.length === 0) {
    return {
      status: 'no_op',
      summary: {
        nodes: nodes.length,
        fleetNamed: fleetSnap.namedIds.length,
        fleetHealthy: fleetSnap.healthy.length,
        services: services.length,
        candidates: fleetSnap.healthy.length,
        unavailable: 0,
        fleetAlertsEmitted: fleetTick.alertedNodeIds,
      },
    };
  }
  return {
    status: 'succeeded',
    title: `${schedule.title}: runtime attention required`,
    summary: {
      nodes: nodes.length,
      fleetNamed: fleetSnap.namedIds.length,
      fleetHealthy: fleetSnap.healthy.length,
      services: services.length,
      offlineFleet: fleetSnap.offline,
      onlineUnverified: fleetSnap.onlineUnverified,
      missingFleet: fleetSnap.missing,
      // Keep legacy key for digests that still read unavailableNodes.
      unavailableNodes: [...fleetSnap.offline, ...fleetSnap.missing],
      unavailableServices: unavailableServices.map(service => service.serviceId),
      fleetAlertsEmitted: fleetTick.alertedNodeIds,
      fleetEmissions: fleetTick.emissions.map((e) => ({
        nodeId: e.nodeId,
        health: e.health,
        consecutiveUnhealthy: e.consecutiveUnhealthy,
        eventEmitted: e.eventEmitted,
        skippedReason: e.skippedReason,
      })),
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
      : `schedule-run-result:${run.id}:${scheduledStatus}`,
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

/**
 * Approve an awaiting_approval scheduled run and execute it.
 *
 * Closes the each_run approval gap: the run is moved through
 * awaiting_approval → claimed → running (state machine permits both hops) and
 * the template executes without re-checking the approval policy (the operator
 * approval is the check). Reuses the ordinary outcome/error transitions.
 * Every approval (manual or auto-timeout) is recorded as an audit event.
 */
export async function approveScheduledWorkRun(
  runId: string,
  input: { ownerId: string },
): Promise<ScheduledWorkItemRun> {
  const run = await loadScheduledWorkItemRun(runId);
  if (!run) throw new Error(`Scheduled work run not found: ${runId}`);
  if (run.status !== 'awaiting_approval') {
    throw new Error(`run must be awaiting_approval to approve (status=${run.status})`);
  }
  const schedule = await loadScheduledWorkItem(run.scheduleId);
  if (!schedule) throw new Error('schedule disappeared before approval');

  // Async approval (A3): mark the run as approved and queue it for the
  // scheduled-work tick loop (claimQueuedScheduledWorkRuns → execute). This
  // keeps the approve HTTP call short instead of synchronously running the
  // whole agent task inside the request.
  const queued = await transitionScheduledWorkRun(run.id, 'queued', {
    ownerId: input.ownerId,
    resultSummary: { ...(run.resultSummary ?? {}), approvedBy: input.ownerId },
  });

  await recordApprovalAudit({
    runId: run.id, scheduleId: schedule.id, scheduleTitle: schedule.title,
    scheduledFor: run.scheduledFor, actor: input.ownerId, action: 'approved',
    timeoutMs: schedule.approvalTimeoutMs,
  });

  // P0-2: while this run waited for approval, later slots of the same
  // schedule were skipped by concurrency_limit (awaiting_approval occupies
  // the single concurrent slot). Recover the most recent missed slot as an
  // approved catch-up run so the analysis is not silently lost. The catch-up
  // run is queued (not executed inline) and carries approvedBy so it skips
  // the approval gate on execution.
  try {
    const missed = await findMissedScheduledRun({ scheduleId: schedule.id, after: new Date(run.scheduledFor) });
    if (missed) {
      await createCatchUpScheduledWorkRun({
        scheduleId: schedule.id,
        ownerId: input.ownerId,
        missedRunId: missed.id,
        maxAttempts: schedule.maxAttempts,
      });
      log.info(`Scheduled work approval queued catch-up run for missed slot ${missed.scheduledFor} (${schedule.title})`);
    }
  } catch (error) {
    // Catch-up is best-effort; the approved run itself already transitioned.
    log.warn(`Scheduled work catch-up failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return queued;
}

/**
 * Deny an awaiting_approval scheduled run. The run is cancelled and the
 * denial is recorded on the run itself (deniedBy) and as an audit event.
 */
export async function denyScheduledWorkRun(
  runId: string,
  input: { ownerId: string },
): Promise<ScheduledWorkItemRun> {
  const run = await loadScheduledWorkItemRun(runId);
  if (!run) throw new Error(`Scheduled work run not found: ${runId}`);
  if (run.status !== 'awaiting_approval') {
    throw new Error(`run must be awaiting_approval to deny (status=${run.status})`);
  }
  const schedule = await loadScheduledWorkItem(run.scheduleId);
  if (!schedule) throw new Error('schedule disappeared before denial');
  const cancelled = await transitionScheduledWorkRun(run.id, 'cancelled', {
    ownerId: input.ownerId,
    resultSummary: { ...(run.resultSummary ?? {}), deniedBy: input.ownerId, deniedReason: 'operator_denied' },
  });
  await recordApprovalAudit({
    runId: run.id, scheduleId: schedule.id, scheduleTitle: schedule.title,
    scheduledFor: run.scheduledFor, actor: input.ownerId, action: 'denied',
    timeoutMs: schedule.approvalTimeoutMs,
  });
  return cancelled;
}

/**
 * Sweep awaiting_approval runs whose approval wait exceeded the schedule's
 * approvalTimeoutMs and dispose them per approvalTimeoutAction ('deny' by
 * default, 'approve' when the schedule opts in). Transitions are atomic
 * (WHERE status='awaiting_approval') so concurrent gateway instances dispose
 * each run exactly once.
 */
export async function expireAwaitingApprovalRuns(input: {
  ownerId: string; now?: Date;
}): Promise<{ autoApproved: string[]; autoDenied: string[] }> {
  const now = input.now ?? new Date();
  const rows = await getDb().query<{
    id: string; schedule_id: string; scheduled_for: Date | string;
    title: string; approval_timeout_ms: number; approval_timeout_action: string;
  }>(
    `SELECT r.id, r.schedule_id, r.scheduled_for, s.title,
            s.approval_timeout_ms, s.approval_timeout_action
     FROM scheduled_work_item_runs r
     JOIN scheduled_work_items s ON s.id = r.schedule_id
     WHERE r.status = 'awaiting_approval' AND s.status = 'enabled'
       AND s.approval_timeout_ms > 0
       AND r.updated_at + make_interval(secs => s.approval_timeout_ms / 1000.0) <= $1
     ORDER BY r.updated_at LIMIT 50`,
    [now],
  );
  const autoApproved: string[] = [];
  const autoDenied: string[] = [];
  for (const row of rows.rows) {
    const actor = 'auto:approval_timeout';
    try {
      if (row.approval_timeout_action === 'approve') {
        await approveScheduledWorkRun(row.id, { ownerId: actor });
        autoApproved.push(row.id);
      } else {
        const run = await loadScheduledWorkItemRun(row.id);
        if (!run || run.status !== 'awaiting_approval') continue;
        await transitionScheduledWorkRun(row.id, 'cancelled', {
          ownerId: actor,
          resultSummary: { ...(run.resultSummary ?? {}), deniedBy: actor, deniedReason: 'approval_timeout' },
        });
        await recordApprovalAudit({
          runId: row.id, scheduleId: row.schedule_id, scheduleTitle: row.title,
          scheduledFor: isoString(row.scheduled_for), actor, action: 'denied',
          timeoutMs: row.approval_timeout_ms,
        });
        autoDenied.push(row.id);
      }
    } catch (error) {
      // Another instance may have disposed the run concurrently; skip.
      log.warn(`Approval timeout dispose failed for ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { autoApproved, autoDenied };
}

async function recordApprovalAudit(input: {
  runId: string; scheduleId: string; scheduleTitle: string; scheduledFor: string;
  actor: string; action: 'approved' | 'denied'; timeoutMs: number;
}): Promise<void> {
  try {
    await appendSessionEvent({
      sessionId: `scheduled:${input.runId}`,
      type: input.action === 'approved' ? 'scheduled_work.approved' : 'scheduled_work.denied',
      source: 'scheduled-work',
      payload: {
        event: input.action === 'approved' ? 'scheduled_run_approved' : 'scheduled_run_denied',
        runId: input.runId,
        scheduleId: input.scheduleId,
        scheduleTitle: input.scheduleTitle,
        scheduledFor: input.scheduledFor,
        actor: input.actor,
        action: input.action,
        approvalTimeoutMs: input.timeoutMs,
        entityId: input.runId,
        entityType: 'scheduled_work_run',
      },
    });
  } catch (error) {
    // Audit is best-effort; never break the approval transition.
    log.warn(`Scheduled work approval audit failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
