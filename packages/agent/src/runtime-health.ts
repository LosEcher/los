/**
 * Runtime health synthesizer — read-only aggregation of service, executor,
 * schedule, and governance surfaces. Does not claim work or restart processes.
 *
 * Policy (2026-08-09): gateway embedded timers are the control plane; this
 * board only reports. No separate main-GA daemon.
 */

import { getDb } from '@los/infra/db';

import { listExecutorNodes } from './executor-nodes.js';
import { evaluateNamedFleet, resolveNamedFleetNodeIds } from './fleet-inventory.js';
import {
  evaluateNamedFleetResources,
  type FleetResourceFinding,
  type FleetResourceNodeSnapshot,
} from './fleet-resources.js';
import { listGovernanceJobs } from './governance-jobs.js';
import { ensureScheduledWorkStore } from './scheduled-work/schema.js';
import { listServiceInstances } from './service-instances.js';

export type RuntimeHealthOverall = 'ok' | 'degraded' | 'critical';

export interface RuntimeHealthReport {
  evidenceClass: 'los_runtime';
  generatedAt: string;
  overall: RuntimeHealthOverall;
  blockers: string[];
  warnings: string[];
  services: {
    total: number;
    ready: number;
    draining: number;
    offline: number;
    items: Array<{
      serviceId: string;
      serviceKind: string;
      status: string;
      ready: boolean;
      version?: string;
      lastHeartbeatAt: string;
      blockers: string[];
    }>;
  };
  executors: {
    total: number;
    candidates: number;
    online: number;
    items: Array<{
      nodeId: string;
      status: string;
      candidate: boolean;
      lastHeartbeatAt: string;
      blockers: string[];
    }>;
  };
  /** Named fleet (LOS_FLEET_NODE_IDS) — supervision surface for P0 alerts. */
  fleet: {
    namedIds: string[];
    healthy: number;
    offline: string[];
    onlineUnverified: string[];
    missing: string[];
    attentionNodeIds: string[];
  };
  /**
   * Fleet resources from last heartbeat capacity only (P1).
   * Does not issue probes; thresholds in fleet-resources.ts.
   */
  fleetResources: {
    assessedAt: string;
    nodes: FleetResourceNodeSnapshot[];
    findings: FleetResourceFinding[];
    warningCount: number;
    criticalCount: number;
  };
  schedules: {
    enabled: number;
    openCircuits: number;
    failedRuns24h: number;
    runningWithExpiredLease: number;
    recentFailures: Array<{
      runId: string;
      scheduleId: string;
      title: string;
      error?: string;
      completedAt?: string;
    }>;
  };
  governance: {
    active: number;
    paused: number;
    circuitOpen: number;
    overdue: number;
  };
  policy: {
    controlPlane: 'gateway_embedded_timers';
    noMainGaDaemon: true;
    upgradePath: 'drain_restart_ready_smoke';
  };
}

export async function getRuntimeHealth(): Promise<RuntimeHealthReport> {
  await ensureScheduledWorkStore();
  const [services, executors, scheduleStats, governanceJobs] = await Promise.all([
    listServiceInstances(50),
    listExecutorNodes(50),
    loadScheduleHealth(),
    listGovernanceJobs({ limit: 100 }),
  ]);

  const blockers: string[] = [];
  const warnings: string[] = [];

  const serviceItems = services.map((svc) => ({
    serviceId: svc.serviceId,
    serviceKind: svc.serviceKind,
    status: svc.status,
    ready: svc.readiness.ready,
    version: svc.version,
    lastHeartbeatAt: svc.lastHeartbeatAt,
    blockers: svc.readiness.blockers,
  }));
  const readyServices = serviceItems.filter((s) => s.ready).length;
  const draining = serviceItems.filter((s) => s.status === 'draining').length;
  const offline = serviceItems.filter((s) => s.status === 'offline').length;
  if (serviceItems.length === 0) blockers.push('services:none_registered');
  else if (readyServices === 0) blockers.push('services:no_ready_gateway');
  if (draining > 0) warnings.push(`services:draining=${draining}`);

  const executorItems = executors.map((node) => ({
    nodeId: node.nodeId,
    status: node.status,
    candidate: node.execution.candidate === true,
    lastHeartbeatAt: node.lastHeartbeatAt,
    blockers: node.execution.blockers ?? [],
  }));
  const candidates = executorItems.filter((n) => n.candidate).length;
  const online = executorItems.filter((n) => n.status === 'online').length;
  if (candidates === 0) warnings.push('executors:no_candidate');

  // Named fleet only — ignore ssh_target / incidental executor rows.
  const namedIds = resolveNamedFleetNodeIds();
  const fleetSnap = evaluateNamedFleet(executors, namedIds);
  if (fleetSnap.offline.length > 0) {
    warnings.push(
      `fleet:offline=${fleetSnap.offline.length}:${fleetSnap.offline.slice(0, 4).join(',')}`,
    );
  }
  if (fleetSnap.onlineUnverified.length > 0) {
    warnings.push(
      `fleet:online_unverified=${fleetSnap.onlineUnverified.length}:${fleetSnap.onlineUnverified.slice(0, 4).join(',')}`,
    );
  }
  if (fleetSnap.missing.length > 0) {
    warnings.push(
      `fleet:missing=${fleetSnap.missing.length}:${fleetSnap.missing.slice(0, 4).join(',')}`,
    );
  }

  // P1: resource thresholds from heartbeat capacity (no extra probes).
  const fleetResources = evaluateNamedFleetResources(executors, namedIds);
  for (const code of fleetResources.criticalCodes) warnings.push(code);
  for (const code of fleetResources.warningCodes) warnings.push(code);

  if (scheduleStats.openCircuits > 0) {
    warnings.push(`schedules:open_circuits=${scheduleStats.openCircuits}`);
  }
  if (scheduleStats.failedRuns24h >= 3) {
    warnings.push(`schedules:failed_runs_24h=${scheduleStats.failedRuns24h}`);
  }
  if (scheduleStats.runningWithExpiredLease > 0) {
    warnings.push(`schedules:expired_lease_running=${scheduleStats.runningWithExpiredLease}`);
  }

  const govActive = governanceJobs.filter((j) => j.status === 'active');
  const govPaused = governanceJobs.filter((j) => j.status === 'paused').length;
  const govOpen = governanceJobs.filter((j) => j.circuitState === 'open').length;
  const now = Date.now();
  const overdue = govActive.filter((j) => j.nextRunAt && Date.parse(j.nextRunAt) < now - 30 * 60_000).length;
  if (govOpen > 0) warnings.push(`governance:circuit_open=${govOpen}`);
  if (overdue > 0) warnings.push(`governance:overdue=${overdue}`);

  let overall: RuntimeHealthOverall = 'ok';
  if (blockers.length > 0) overall = 'critical';
  else if (warnings.length > 0) overall = 'degraded';

  return {
    evidenceClass: 'los_runtime',
    generatedAt: new Date().toISOString(),
    overall,
    blockers,
    warnings,
    services: {
      total: serviceItems.length,
      ready: readyServices,
      draining,
      offline,
      items: serviceItems,
    },
    executors: {
      total: executorItems.length,
      candidates,
      online,
      items: executorItems,
    },
    fleet: {
      namedIds: fleetSnap.namedIds,
      healthy: fleetSnap.healthy.length,
      offline: fleetSnap.offline,
      onlineUnverified: fleetSnap.onlineUnverified,
      missing: fleetSnap.missing,
      attentionNodeIds: fleetSnap.attentionNodeIds,
    },
    fleetResources: {
      assessedAt: fleetResources.assessedAt,
      nodes: fleetResources.nodes,
      findings: fleetResources.findings,
      warningCount: fleetResources.warningCodes.length,
      criticalCount: fleetResources.criticalCodes.length,
    },
    schedules: {
      enabled: scheduleStats.enabled,
      openCircuits: scheduleStats.openCircuits,
      failedRuns24h: scheduleStats.failedRuns24h,
      runningWithExpiredLease: scheduleStats.runningWithExpiredLease,
      recentFailures: scheduleStats.recentFailures,
    },
    governance: {
      active: govActive.length,
      paused: govPaused,
      circuitOpen: govOpen,
      overdue,
    },
    policy: {
      controlPlane: 'gateway_embedded_timers',
      noMainGaDaemon: true,
      upgradePath: 'drain_restart_ready_smoke',
    },
  };
}

async function loadScheduleHealth(): Promise<{
  enabled: number;
  openCircuits: number;
  failedRuns24h: number;
  runningWithExpiredLease: number;
  recentFailures: RuntimeHealthReport['schedules']['recentFailures'];
}> {
  const db = getDb();
  const counts = await db.query<{
    enabled: string;
    open_circuits: string;
    failed_24h: string;
    expired_running: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM scheduled_work_items WHERE status='enabled') AS enabled,
       (SELECT count(*)::text FROM scheduled_work_items WHERE status='enabled' AND circuit_state='open') AS open_circuits,
       (SELECT count(*)::text FROM scheduled_work_item_runs
         WHERE status='failed' AND completed_at >= now() - interval '24 hours') AS failed_24h,
       (SELECT count(*)::text FROM scheduled_work_item_runs
         WHERE status IN ('claimed','running')
           AND lease_expires_at IS NOT NULL AND lease_expires_at < now()) AS expired_running`,
  );
  const failures = await db.query<{
    id: string; schedule_id: string; title: string; error: string | null; completed_at: Date | string | null;
  }>(
    `SELECT r.id, r.schedule_id, s.title, r.error, r.completed_at
       FROM scheduled_work_item_runs r
       JOIN scheduled_work_items s ON s.id = r.schedule_id
      WHERE r.status = 'failed' AND r.completed_at >= now() - interval '24 hours'
      ORDER BY r.completed_at DESC NULLS LAST
      LIMIT 10`,
  );
  const row = counts.rows[0];
  return {
    enabled: Number(row?.enabled ?? 0),
    openCircuits: Number(row?.open_circuits ?? 0),
    failedRuns24h: Number(row?.failed_24h ?? 0),
    runningWithExpiredLease: Number(row?.expired_running ?? 0),
    recentFailures: failures.rows.map((f) => ({
      runId: f.id,
      scheduleId: f.schedule_id,
      title: f.title,
      error: f.error ?? undefined,
      completedAt: f.completed_at
        ? (f.completed_at instanceof Date ? f.completed_at.toISOString() : String(f.completed_at))
        : undefined,
    })),
  };
}
