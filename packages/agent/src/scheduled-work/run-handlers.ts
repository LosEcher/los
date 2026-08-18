/**
 * Lightweight scheduled template handlers (no provider).
 * Kept out of runner.ts to stay under the 700-line module gate.
 */

import { listExecutorNodes } from '../executor-nodes.js';
import { dispatchFeedAnalysisJob } from '../integration/feed-analysis-ingress.js';
import type { FeedAnalysisDispatchRequest } from '../integration/feed-analysis-types.js';
import { listServiceInstances } from '../service-instances.js';
import { listInboxEntries } from '../work-items/projection.js';
import type { ScheduledWorkItem, ScheduledWorkItemRun, ScheduledWorkRunOutcome } from './types.js';

export const _FLEET_OBSERVATION_MAX_SCHEDULE_LATENESS_MS = 2 * 60_000;

/**
 * Pure gate for the event-driven repair trigger: auto-repair consented, at
 * least one fleet node offline, and the fleet quorum is intact (offline share
 * <= threshold). Guarding by quorum prevents the MBP-wake-up storm where every
 * remote heartbeat is simultaneously stale.
 */
export function shouldTriggerFleetRepair(
  offlineIds: string[],
  namedCount: number,
  autoRepair: boolean,
  quorumThreshold = 0.5,
): boolean {
  if (!autoRepair || offlineIds.length === 0 || namedCount <= 0) return false;
  return offlineIds.length / namedCount <= quorumThreshold;
}

export function _shouldRecordFleetObservation(
  run: Pick<ScheduledWorkItemRun, 'scheduledFor' | 'triggerKind'>,
  now: Date = new Date(),
): boolean {
  if (run.triggerKind !== 'scheduled') return true;
  const scheduledForMs = Date.parse(run.scheduledFor);
  if (!Number.isFinite(scheduledForMs)) return false;
  return now.getTime() - scheduledForMs <= _FLEET_OBSERVATION_MAX_SCHEDULE_LATENESS_MS;
}

export async function handleMorningInboxDigest(
  schedule: ScheduledWorkItem,
): Promise<ScheduledWorkRunOutcome> {
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

export async function handleDailyExecutionDigest(
  schedule: ScheduledWorkItem,
  run: ScheduledWorkItemRun,
): Promise<ScheduledWorkRunOutcome> {
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

export async function handleFleetHostCheck(
  schedule: ScheduledWorkItem,
  run: ScheduledWorkItemRun,
): Promise<ScheduledWorkRunOutcome> {
  const { runFleetHostChecks } = await import('../fleet-host-checks.js');
  // Repair gates resolve internally: per-node policy > global DB > env > default.
  const report = await runFleetHostChecks({
    tenantId: schedule.tenantId,
    projectId: schedule.projectId,
    scheduleId: schedule.id,
    runId: run.id,
    force: false,
  });
  const attention = [...report.failed, ...report.degraded];
  const summary = {
    assessedAt: report.assessedAt,
    checked: report.checked,
    skipped: report.skipped,
    ok: report.ok,
    failed: report.failed,
    degraded: report.degraded,
    alertsEmitted: report.alertsEmitted,
    repairs: report.repairs.map((r) => ({
      nodeId: r.nodeId,
      action: r.action,
      outcome: r.outcome,
      skipReason: r.skipReason ?? null,
      detail: r.detail,
    })),
    results: report.results.map((r) => ({
      nodeId: r.nodeId,
      status: r.status,
      detail: r.detail,
      durationMs: r.durationMs,
    })),
  };
  if (attention.length === 0) {
    return {
      status: report.checked.length === 0 ? 'no_op' : 'succeeded',
      title: report.checked.length === 0
        ? `${schedule.title}: no hosts checked`
        : `${schedule.title}: ${report.ok.length} host(s) ok`,
      summary,
    };
  }
  return {
    status: 'succeeded',
    title: `${schedule.title}: host attention ${attention.join(',')}`,
    summary,
  };
}

export async function handleScheduledFeedAnalysis(
  schedule: ScheduledWorkItem,
  run: ScheduledWorkItemRun,
  workspaceRoot: string,
  derive: (schedule: ScheduledWorkItem, run: ScheduledWorkItemRun) => {
    request: FeedAnalysisDispatchRequest;
    idempotencyKey: string;
  },
): Promise<ScheduledWorkRunOutcome> {
  const derived = derive(schedule, run);
  const result = await dispatchFeedAnalysisJob(derived.request, derived.idempotencyKey, {
    workspaceRoot,
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

/** Shared readiness/fleet attention path used by runtime_readiness template. */
export async function handleRuntimeReadiness(
  schedule: ScheduledWorkItem,
  run: ScheduledWorkItemRun,
): Promise<ScheduledWorkRunOutcome> {
  const [nodes, services] = await Promise.all([listExecutorNodes(), listServiceInstances()]);
  const { evaluateNamedFleet, tickNamedFleetWatch } = await import('../fleet-inventory.js');
  const recordFleetObservation = _shouldRecordFleetObservation(run);
  const fleetTick = recordFleetObservation
    ? await tickNamedFleetWatch(nodes, {
      tenantId: schedule.tenantId,
      projectId: schedule.projectId,
      scheduleId: schedule.id,
      runId: run.id,
    })
    : {
      snapshot: evaluateNamedFleet(nodes),
      emissions: [],
      alertedNodeIds: [],
    };
  const fleetSnap = fleetTick.snapshot;
  const fleetObservation = recordFleetObservation ? 'recorded' : 'skipped_late_run';

  // Event-driven repair trigger (P2'): a single node went offline in the
  // registry while the fleet quorum is intact (<=50% offline) → run a host
  // check + repair for exactly those nodes now, instead of waiting for the
  // 6h fleet_host_check schedule. Repair gates (cooldown / consecutive
  // failures / per-node policy) still apply inside runFleetHostChecks.
  const fleetAutoRepair = process.env.LOS_FLEET_AUTO_REPAIR?.trim().toLowerCase() === 'true';
  const offlineFleetIds = [...fleetSnap.offline, ...fleetSnap.missing];
  let triggeredRepairs: Array<{ nodeId: string; outcome: string; detail: string }> = [];
  if (shouldTriggerFleetRepair(offlineFleetIds, fleetSnap.namedIds.length, fleetAutoRepair)) {
    try {
      const { resolveFleetHostTargets, runFleetHostChecks } = await import('../fleet-host-checks.js');
      const targets = resolveFleetHostTargets().filter((t) => offlineFleetIds.includes(t.nodeId));
      if (targets.length > 0) {
        // Repair gates resolve internally (per-node policy > global DB > env).
        const repairReport = await runFleetHostChecks({
          force: true,
          targets,
          autoRepair: true,
          tenantId: schedule.tenantId,
          projectId: schedule.projectId,
          scheduleId: schedule.id,
          runId: run.id,
        });
        triggeredRepairs = repairReport.repairs.map((r) => ({
          nodeId: r.nodeId,
          outcome: r.outcome,
          detail: r.detail,
        }));
      }
    } catch {
      // Repair is best-effort; readiness outcome must not fail because of it.
      triggeredRepairs = [];
    }
  }

  const unavailableServices = services.filter((service) => {
    if (service.serviceKind !== 'gateway') return false;
    if (service.status === 'online') return service.readiness?.ready !== true;
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
        fleetObservation,
        fleetAlertsEmitted: fleetTick.alertedNodeIds,
        triggeredRepairs,
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
      unavailableNodes: [...fleetSnap.offline, ...fleetSnap.missing],
      unavailableServices: unavailableServices.map((service) => service.serviceId),
      fleetObservation,
      fleetAlertsEmitted: fleetTick.alertedNodeIds,
      fleetEmissions: fleetTick.emissions.map((e) => ({
        nodeId: e.nodeId,
        health: e.health,
        consecutiveUnhealthy: e.consecutiveUnhealthy,
        eventEmitted: e.eventEmitted,
        skippedReason: e.skippedReason,
      })),
      triggeredRepairs,
    },
  };
}
