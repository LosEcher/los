/**
 * Fleet resource supervision (P1 monitoring).
 *
 * Pure evaluation from the last heartbeat capacity / load fields only —
 * no extra HTTP probes. Thresholds match
 * docs/operations/2026-08-10-executor-fleet-status-and-monitoring-plan.md §4.3 P1.
 */

import type { ExecutorNodeRecord } from './executor-nodes.js';
import { resolveNamedFleetNodeIds } from './fleet-inventory.js';

/** Available-memory ratio below this → warning (plan default 15%). */
export const FLEET_MEM_AVAILABLE_WARN_RATIO = 0.15;
/** Available-memory ratio below this → critical (matches candidate blocker 5%). */
export const FLEET_MEM_AVAILABLE_CRITICAL_RATIO = 0.05;
/** Swap used ratio above this → warning. */
export const FLEET_SWAP_USED_WARN_RATIO = 0.5;
/** Swap used ratio above this → critical. */
export const FLEET_SWAP_USED_CRITICAL_RATIO = 0.8;
/** load1 / cores above this → warning (when both fields present). */
export const FLEET_CPU_LOAD_WARN = 2.0;
/** load1 / cores above this → critical. */
export const FLEET_CPU_LOAD_CRITICAL = 4.0;
/** Heartbeat age warning (ms). */
export const FLEET_HEARTBEAT_WARN_MS = 45_000;
/** Heartbeat age critical (ms) — path/gateway check. */
export const FLEET_HEARTBEAT_CRITICAL_MS = 90_000;
/** Nodes at or below this total RAM are treated as light/overflow. */
export const FLEET_LIGHT_NODE_MEMORY_TOTAL_MB = 2048;
 /** Absolute available-memory warning (standard nodes): <512MB free. */
const FLEET_MEM_AVAILABLE_ABS_WARN_MB = 512;
 /** Absolute available-memory critical (standard nodes): <256MB free. */
const FLEET_MEM_AVAILABLE_ABS_CRITICAL_MB = 256;
 /** Absolute available-memory warning on light nodes: <256MB free. */
const FLEET_LIGHT_MEM_AVAILABLE_ABS_WARN_MB = 256;

export type FleetResourceSeverity = 'warning' | 'critical';

export type FleetResourceSignal =
  | 'memory_available'
  | 'swap_used'
  | 'cpu_load'
  | 'active_tasks_light_node'
  | 'heartbeat_age'
  | 'capacity_missing';

export interface FleetResourceFinding {
  nodeId: string;
  signal: FleetResourceSignal;
  severity: FleetResourceSeverity;
  /** Machine-readable code for top-level runtime-health warnings[]. */
  code: string;
  message: string;
  metrics: Record<string, number | string | boolean | null>;
}

export interface FleetResourceNodeSnapshot {
  nodeId: string;
  status?: string;
  candidate?: boolean;
  lastHeartbeatAt?: string;
  heartbeatAgeMs?: number;
  memoryAvailableMb?: number;
  memoryTotalMb?: number;
  memoryAvailableRatio?: number;
  swapUsedMb?: number;
  swapTotalMb?: number;
  swapUsedRatio?: number;
  cpuLoad1m?: number;
  cpuCores?: number;
  cpuLoadPerCore?: number;
  activeTaskCount: number;
  lightNode: boolean;
  findings: FleetResourceFinding[];
}

export interface FleetResourceSnapshot {
  assessedAt: string;
  namedIds: string[];
  nodes: FleetResourceNodeSnapshot[];
  findings: FleetResourceFinding[];
  warningCodes: string[];
  criticalCodes: string[];
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function ratio(numerator: number | undefined, denominator: number | undefined): number | undefined {
  if (numerator === undefined || denominator === undefined) return undefined;
  if (!(denominator > 0)) return undefined;
  return numerator / denominator;
}

export function isLightFleetNode(node: ExecutorNodeRecord | undefined, nodeId: string): boolean {
  if (!node) return /oracle/i.test(nodeId);
  if (node.resourceClass === 'constrained_executor') return true;
  const total = num(node.capacity?.memoryTotalMb);
  if (total !== undefined && total <= FLEET_LIGHT_NODE_MEMORY_TOTAL_MB) return true;
  return /oracle/i.test(nodeId);
}

/**
 * Evaluate one fleet node from registry capacity fields only.
 * Missing capacity yields a single capacity_missing warning when the node is online.
 */
export function evaluateFleetNodeResources(
  nodeId: string,
  node: ExecutorNodeRecord | undefined,
  nowMs: number = Date.now(),
): FleetResourceNodeSnapshot {
  if (!node) {
    return {
      nodeId,
      activeTaskCount: 0,
      lightNode: isLightFleetNode(undefined, nodeId),
      findings: [],
    };
  }

  const findings: FleetResourceFinding[] = [];
  const capacity = node.capacity ?? {};
  const memoryAvailableMb = num(capacity.memoryAvailableMb);
  const memoryTotalMb = num(capacity.memoryTotalMb);
  const memoryAvailableRatio = ratio(memoryAvailableMb, memoryTotalMb);
  const swapUsedMb = num(capacity.swapUsedMb);
  const swapTotalMb = num(capacity.swapTotalMb);
  const swapUsedRatio = ratio(swapUsedMb, swapTotalMb);
  const cpuLoad1m = num((capacity as Record<string, unknown>).cpuLoad1m)
    ?? num((capacity as Record<string, unknown>).load1m)
    ?? num((capacity as Record<string, unknown>).loadavg1);
  const cpuCores = num((capacity as Record<string, unknown>).cpuCores)
    ?? num((capacity as Record<string, unknown>).cpus);
  const cpuLoadPerCore = ratio(cpuLoad1m, cpuCores);
  const activeTaskCount = Number(node.activeTaskCount ?? 0);
  const lightNode = isLightFleetNode(node, nodeId);

  let heartbeatAgeMs: number | undefined;
  if (node.lastHeartbeatAt) {
    const ts = Date.parse(node.lastHeartbeatAt);
    if (Number.isFinite(ts)) heartbeatAgeMs = Math.max(0, nowMs - ts);
  }

  const online = node.status === 'online';

  if (online && memoryAvailableRatio === undefined && swapUsedRatio === undefined) {
    findings.push({
      nodeId,
      signal: 'capacity_missing',
      severity: 'warning',
      code: `resource:capacity_missing:${nodeId}`,
      message: `${nodeId}: online but no memory/swap capacity on last heartbeat`,
      metrics: { status: node.status },
    });
  }

  if (memoryAvailableRatio !== undefined) {
    if (memoryAvailableRatio < FLEET_MEM_AVAILABLE_CRITICAL_RATIO) {
      findings.push({
        nodeId,
        signal: 'memory_available',
        severity: 'critical',
        code: `resource:memory_critical:${nodeId}`,
        message:
          `${nodeId}: memory available ${(memoryAvailableRatio * 100).toFixed(1)}% `
          + `(< ${(FLEET_MEM_AVAILABLE_CRITICAL_RATIO * 100).toFixed(0)}%)`,
        metrics: {
          memoryAvailableMb: memoryAvailableMb ?? null,
          memoryTotalMb: memoryTotalMb ?? null,
          memoryAvailableRatio,
        },
      });
    } else if (memoryAvailableRatio < FLEET_MEM_AVAILABLE_WARN_RATIO) {
      findings.push({
        nodeId,
        signal: 'memory_available',
        severity: 'warning',
        code: `resource:memory_low:${nodeId}`,
        message:
          `${nodeId}: memory available ${(memoryAvailableRatio * 100).toFixed(1)}% `
          + `(< ${(FLEET_MEM_AVAILABLE_WARN_RATIO * 100).toFixed(0)}%)`,
        metrics: {
          memoryAvailableMb: memoryAvailableMb ?? null,
          memoryTotalMb: memoryTotalMb ?? null,
          memoryAvailableRatio,
        },
      });
    }
  }

  if (swapUsedRatio !== undefined && (swapTotalMb ?? 0) > 0) {
    if (swapUsedRatio > FLEET_SWAP_USED_CRITICAL_RATIO) {
      findings.push({
        nodeId,
        signal: 'swap_used',
        severity: 'critical',
        code: `resource:swap_critical:${nodeId}`,
        message:
          `${nodeId}: swap used ${(swapUsedRatio * 100).toFixed(1)}% `
          + `(> ${(FLEET_SWAP_USED_CRITICAL_RATIO * 100).toFixed(0)}%)`,
        metrics: {
          swapUsedMb: swapUsedMb ?? null,
          swapTotalMb: swapTotalMb ?? null,
          swapUsedRatio,
        },
      });
    } else if (swapUsedRatio > FLEET_SWAP_USED_WARN_RATIO) {
      findings.push({
        nodeId,
        signal: 'swap_used',
        severity: 'warning',
        code: `resource:swap_high:${nodeId}`,
        message:
          `${nodeId}: swap used ${(swapUsedRatio * 100).toFixed(1)}% `
          + `(> ${(FLEET_SWAP_USED_WARN_RATIO * 100).toFixed(0)}%)`,
        metrics: {
          swapUsedMb: swapUsedMb ?? null,
          swapTotalMb: swapTotalMb ?? null,
          swapUsedRatio,
        },
      });
    }
  }

  if (cpuLoadPerCore !== undefined) {
    if (cpuLoadPerCore > FLEET_CPU_LOAD_CRITICAL) {
      findings.push({
        nodeId,
        signal: 'cpu_load',
        severity: 'critical',
        code: `resource:cpu_critical:${nodeId}`,
        message: `${nodeId}: load/core ${cpuLoadPerCore.toFixed(2)} (> ${FLEET_CPU_LOAD_CRITICAL})`,
        metrics: {
          cpuLoad1m: cpuLoad1m ?? null,
          cpuCores: cpuCores ?? null,
          cpuLoadPerCore,
        },
      });
    } else if (cpuLoadPerCore > FLEET_CPU_LOAD_WARN) {
      findings.push({
        nodeId,
        signal: 'cpu_load',
        severity: 'warning',
        code: `resource:cpu_high:${nodeId}`,
        message: `${nodeId}: load/core ${cpuLoadPerCore.toFixed(2)} (> ${FLEET_CPU_LOAD_WARN})`,
        metrics: {
          cpuLoad1m: cpuLoad1m ?? null,
          cpuCores: cpuCores ?? null,
          cpuLoadPerCore,
        },
      });
    }
  }

  if (lightNode && online && activeTaskCount > 0) {
    findings.push({
      nodeId,
      signal: 'active_tasks_light_node',
      severity: 'warning',
      code: `resource:active_on_light:${nodeId}`,
      message: `${nodeId}: light/overflow node has activeTaskCount=${activeTaskCount}`,
      metrics: { activeTaskCount, lightNode: true },
    });
  }

  if (heartbeatAgeMs !== undefined) {
    if (heartbeatAgeMs > FLEET_HEARTBEAT_CRITICAL_MS) {
      findings.push({
        nodeId,
        signal: 'heartbeat_age',
        severity: 'critical',
        code: `resource:heartbeat_stale:${nodeId}`,
        message: `${nodeId}: heartbeat age ${Math.round(heartbeatAgeMs / 1000)}s (> ${FLEET_HEARTBEAT_CRITICAL_MS / 1000}s)`,
        metrics: { heartbeatAgeMs, lastHeartbeatAt: node.lastHeartbeatAt ?? null },
      });
    } else if (heartbeatAgeMs > FLEET_HEARTBEAT_WARN_MS) {
      findings.push({
        nodeId,
        signal: 'heartbeat_age',
        severity: 'warning',
        code: `resource:heartbeat_lag:${nodeId}`,
        message: `${nodeId}: heartbeat age ${Math.round(heartbeatAgeMs / 1000)}s (> ${FLEET_HEARTBEAT_WARN_MS / 1000}s)`,
        metrics: { heartbeatAgeMs, lastHeartbeatAt: node.lastHeartbeatAt ?? null },
      });
    }
  } else if (online) {
    findings.push({
      nodeId,
      signal: 'heartbeat_age',
      severity: 'critical',
      code: `resource:heartbeat_missing:${nodeId}`,
      message: `${nodeId}: online without parseable lastHeartbeatAt`,
      metrics: { lastHeartbeatAt: node.lastHeartbeatAt ?? null },
    });
  }

  return {
    nodeId,
    status: node.status,
    candidate: node.execution?.candidate === true,
    lastHeartbeatAt: node.lastHeartbeatAt,
    heartbeatAgeMs,
    memoryAvailableMb,
    memoryTotalMb,
    memoryAvailableRatio,
    swapUsedMb,
    swapTotalMb,
    swapUsedRatio,
    cpuLoad1m,
    cpuCores,
    cpuLoadPerCore,
    activeTaskCount,
    lightNode,
    findings,
  };
}

export function evaluateNamedFleetResources(
  nodes: ExecutorNodeRecord[],
  namedIds: string[] = resolveNamedFleetNodeIds(),
  nowMs: number = Date.now(),
): FleetResourceSnapshot {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const assessed = namedIds.map((id) => evaluateFleetNodeResources(id, byId.get(id), nowMs));
  const findings = assessed.flatMap((n) => n.findings);
  const warningCodes = findings
    .filter((f) => f.severity === 'warning')
    .map((f) => f.code);
  const criticalCodes = findings
    .filter((f) => f.severity === 'critical')
    .map((f) => f.code);
  return {
    assessedAt: new Date(nowMs).toISOString(),
    namedIds: [...namedIds],
    nodes: assessed,
    findings,
    warningCodes,
    criticalCodes,
  };
}

/** Compact summary lines for digests / WeChat (no probe side effects). */
export function formatFleetResourceSummary(snapshot: FleetResourceSnapshot): string[] {
  const lines: string[] = [];
  for (const node of snapshot.nodes) {
    const mem = node.memoryAvailableRatio !== undefined
      ? `mem=${(node.memoryAvailableRatio * 100).toFixed(0)}%`
      : 'mem=n/a';
    const swap = node.swapUsedRatio !== undefined
      ? `swap=${(node.swapUsedRatio * 100).toFixed(0)}%`
      : null;
    const parts = [
      node.nodeId,
      node.status ?? 'missing',
      node.candidate === true ? 'cand' : 'non-cand',
      mem,
      swap,
      `tasks=${node.activeTaskCount}`,
    ].filter(Boolean);
    lines.push(parts.join(' '));
  }
  for (const f of snapshot.findings) {
    lines.push(`[${f.severity}] ${f.message}`);
  }
  return lines;
}
