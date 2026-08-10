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
  const { tickNamedFleetWatch } = await import('../fleet-inventory.js');
  const fleetTick = await tickNamedFleetWatch(nodes, {
    tenantId: schedule.tenantId,
    projectId: schedule.projectId,
    scheduleId: schedule.id,
    runId: run.id,
  });
  const fleetSnap = fleetTick.snapshot;
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
      unavailableNodes: [...fleetSnap.offline, ...fleetSnap.missing],
      unavailableServices: unavailableServices.map((service) => service.serviceId),
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
