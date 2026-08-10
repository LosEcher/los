/**
 * Named fleet inventory + consecutive-tick attention (P0 monitoring).
 *
 * Default fleet: mbp / node34 / oracle / desktop-r45553o. Override with
 * LOS_FLEET_NODE_IDS (comma-separated). Alerts only after N consecutive
 * unhealthy dogfood ticks and respect a cooldown so WeChat is not flooded.
 */

import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import type { ExecutorNodeRecord } from './executor-nodes.js';
import { appendSessionEvent } from './session-events.js';

const log = getLogger('fleet-inventory');

export const DEFAULT_NAMED_FLEET_NODE_IDS = [
  'mbp-executor-1',
  'node34-executor-1',
  'oracle-executor',
  'desktop-r45553o',
] as const;

/** Consecutive unhealthy readiness ticks before an attention event (default 2). */
export const DEFAULT_FLEET_ALERT_CONSECUTIVE_TICKS = 2;
/** Min interval between attention events per node (default 30m). */
export const DEFAULT_FLEET_ALERT_COOLDOWN_MS = 30 * 60_000;

export type FleetNodeHealth = 'healthy' | 'offline' | 'online_unverified' | 'missing';

export interface FleetNodeAssessment {
  nodeId: string;
  health: FleetNodeHealth;
  status?: string;
  candidate?: boolean;
  blockers: string[];
  lastHeartbeatAt?: string;
  version?: string;
}

export interface NamedFleetSnapshot {
  namedIds: string[];
  assessments: FleetNodeAssessment[];
  healthy: string[];
  offline: string[];
  onlineUnverified: string[];
  missing: string[];
  /** Nodes that should open degraded/attention paths. */
  attentionNodeIds: string[];
}

export interface FleetWatchTickOptions {
  consecutiveTicks?: number;
  cooldownMs?: number;
  now?: Date;
  tenantId?: string;
  projectId?: string;
  /** When true, update watch state but do not emit session events. */
  dryRun?: boolean;
  scheduleId?: string;
  runId?: string;
}

export interface FleetAlertEmission {
  nodeId: string;
  health: FleetNodeHealth;
  consecutiveUnhealthy: number;
  eventEmitted: boolean;
  skippedReason?: 'below_threshold' | 'cooldown' | 'healthy' | 'dry_run' | 'emit_failed';
}

export interface FleetWatchTickResult {
  snapshot: NamedFleetSnapshot;
  emissions: FleetAlertEmission[];
  alertedNodeIds: string[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS fleet_watch_state (
  node_id TEXT PRIMARY KEY,
  consecutive_unhealthy INTEGER NOT NULL DEFAULT 0,
  last_health TEXT NOT NULL DEFAULT 'unknown',
  last_alert_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

let _initialized = false;

export async function ensureFleetWatchStore(): Promise<void> {
  if (_initialized) return;
  const db = getDb();
  await db.exec(SCHEMA);
  _initialized = true;
}

/** Test helper — next ensure recreates schema readiness. */
export function _resetFleetWatchStoreForTests(): void {
  _initialized = false;
}

export function resolveNamedFleetNodeIds(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const raw = env.LOS_FLEET_NODE_IDS?.trim();
  if (!raw) return [...DEFAULT_NAMED_FLEET_NODE_IDS];
  const ids = raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length > 0 ? [...new Set(ids)] : [...DEFAULT_NAMED_FLEET_NODE_IDS];
}

export function resolveFleetAlertConsecutiveTicks(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.LOS_FLEET_ALERT_CONSECUTIVE_TICKS?.trim();
  if (!raw) return DEFAULT_FLEET_ALERT_CONSECUTIVE_TICKS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_FLEET_ALERT_CONSECUTIVE_TICKS;
  return Math.floor(n);
}

export function resolveFleetAlertCooldownMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.LOS_FLEET_ALERT_COOLDOWN_MS?.trim();
  if (!raw) return DEFAULT_FLEET_ALERT_COOLDOWN_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_FLEET_ALERT_COOLDOWN_MS;
  return Math.floor(n);
}

export function classifyNamedFleetNode(
  nodeId: string,
  node: ExecutorNodeRecord | undefined,
): FleetNodeAssessment {
  if (!node) {
    return { nodeId, health: 'missing', blockers: ['registry:missing'] };
  }
  if (node.status !== 'online') {
    return {
      nodeId,
      health: 'offline',
      status: node.status,
      candidate: false,
      blockers: node.execution.blockers ?? [`status:${node.status}`],
      lastHeartbeatAt: node.lastHeartbeatAt,
      version: node.version,
    };
  }
  if (node.execution.candidate !== true) {
    return {
      nodeId,
      health: 'online_unverified',
      status: node.status,
      candidate: false,
      blockers: node.execution.blockers ?? ['execution:not_candidate'],
      lastHeartbeatAt: node.lastHeartbeatAt,
      version: node.version,
    };
  }
  return {
    nodeId,
    health: 'healthy',
    status: node.status,
    candidate: true,
    blockers: [],
    lastHeartbeatAt: node.lastHeartbeatAt,
    version: node.version,
  };
}

export function evaluateNamedFleet(
  nodes: ExecutorNodeRecord[],
  namedIds: string[] = resolveNamedFleetNodeIds(),
): NamedFleetSnapshot {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const assessments = namedIds.map((id) => classifyNamedFleetNode(id, byId.get(id)));
  const healthy = assessments.filter((a) => a.health === 'healthy').map((a) => a.nodeId);
  const offline = assessments.filter((a) => a.health === 'offline').map((a) => a.nodeId);
  const onlineUnverified = assessments
    .filter((a) => a.health === 'online_unverified')
    .map((a) => a.nodeId);
  const missing = assessments.filter((a) => a.health === 'missing').map((a) => a.nodeId);
  return {
    namedIds: [...namedIds],
    assessments,
    healthy,
    offline,
    onlineUnverified,
    missing,
    attentionNodeIds: [...offline, ...onlineUnverified, ...missing],
  };
}

interface FleetWatchRow {
  node_id: string;
  consecutive_unhealthy: number | string;
  last_health: string;
  last_alert_at: Date | string | null;
  updated_at: Date | string;
}

/**
 * Advance per-node consecutive unhealthy counters and emit rate-limited
 * `ops.fleet_attention` session events for WeChat / operator SSE.
 */
export async function tickNamedFleetWatch(
  nodes: ExecutorNodeRecord[],
  options: FleetWatchTickOptions = {},
): Promise<FleetWatchTickResult> {
  await ensureFleetWatchStore();
  const namedIds = resolveNamedFleetNodeIds();
  const snapshot = evaluateNamedFleet(nodes, namedIds);
  const consecutiveTicks = options.consecutiveTicks ?? resolveFleetAlertConsecutiveTicks();
  const cooldownMs = options.cooldownMs ?? resolveFleetAlertCooldownMs();
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const db = getDb();
  const emissions: FleetAlertEmission[] = [];
  const alertedNodeIds: string[] = [];

  for (const assessment of snapshot.assessments) {
    const existing = await db.query<FleetWatchRow>(
      'SELECT * FROM fleet_watch_state WHERE node_id = $1',
      [assessment.nodeId],
    );
    const prev = existing.rows[0];
    const prevConsecutive = Number(prev?.consecutive_unhealthy ?? 0);
    const unhealthy = assessment.health !== 'healthy';
    const consecutive = unhealthy ? prevConsecutive + 1 : 0;
    const lastAlertAt = prev?.last_alert_at
      ? (prev.last_alert_at instanceof Date
        ? prev.last_alert_at
        : new Date(String(prev.last_alert_at)))
      : null;
    const lastAlertMs = lastAlertAt && Number.isFinite(lastAlertAt.getTime())
      ? lastAlertAt.getTime()
      : 0;

    let emission: FleetAlertEmission = {
      nodeId: assessment.nodeId,
      health: assessment.health,
      consecutiveUnhealthy: consecutive,
      eventEmitted: false,
      skippedReason: unhealthy ? 'below_threshold' : 'healthy',
    };

    const shouldAlert =
      unhealthy
      && consecutive >= consecutiveTicks
      && (lastAlertMs === 0 || nowMs - lastAlertMs >= cooldownMs);

    let nextAlertAt: Date | null = lastAlertAt;

    if (shouldAlert) {
      if (options.dryRun) {
        emission = {
          ...emission,
          skippedReason: 'dry_run',
        };
      } else {
        try {
          await publishFleetAttentionEvent(assessment, consecutive, {
            tenantId: options.tenantId,
            projectId: options.projectId,
            scheduleId: options.scheduleId,
            runId: options.runId,
            now,
          });
          nextAlertAt = now;
          emission = {
            ...emission,
            eventEmitted: true,
            skippedReason: undefined,
          };
          alertedNodeIds.push(assessment.nodeId);
        } catch (err) {
          log.warn(
            `fleet attention emit failed node=${assessment.nodeId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          emission = {
            ...emission,
            skippedReason: 'emit_failed',
          };
        }
      }
    } else if (unhealthy && consecutive >= consecutiveTicks && lastAlertMs > 0) {
      emission = {
        ...emission,
        skippedReason: 'cooldown',
      };
    }

    await db.query(
      `INSERT INTO fleet_watch_state (node_id, consecutive_unhealthy, last_health, last_alert_at, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (node_id) DO UPDATE SET
         consecutive_unhealthy = EXCLUDED.consecutive_unhealthy,
         last_health = EXCLUDED.last_health,
         last_alert_at = EXCLUDED.last_alert_at,
         updated_at = EXCLUDED.updated_at`,
      [
        assessment.nodeId,
        consecutive,
        assessment.health,
        nextAlertAt,
        now,
      ],
    );

    emissions.push(emission);
  }

  return { snapshot, emissions, alertedNodeIds };
}

async function publishFleetAttentionEvent(
  assessment: FleetNodeAssessment,
  consecutiveUnhealthy: number,
  ctx: {
    tenantId?: string;
    projectId?: string;
    scheduleId?: string;
    runId?: string;
    now: Date;
  },
): Promise<void> {
  const day = ctx.now.toISOString().slice(0, 10);
  const title = `舰队节点异常: ${assessment.nodeId} (${assessment.health})`;
  const detail = [
    `node=${assessment.nodeId}`,
    `health=${assessment.health}`,
    `status=${assessment.status ?? 'n/a'}`,
    `candidate=${assessment.candidate === true}`,
    `consecutive_unhealthy_ticks=${consecutiveUnhealthy}`,
    assessment.blockers.length ? `blockers=${assessment.blockers.join(',')}` : null,
    assessment.lastHeartbeatAt ? `last_heartbeat=${assessment.lastHeartbeatAt}` : null,
    assessment.version ? `version=${assessment.version}` : null,
  ].filter(Boolean).join('\n');

  await appendSessionEvent({
    sessionId: `ops:fleet:${assessment.nodeId}`,
    type: 'ops.fleet_attention',
    source: 'ops',
    tenantId: ctx.tenantId?.trim() || 'local',
    projectId: ctx.projectId?.trim() || 'los',
    payload: {
      kind: 'fleet_attention',
      severity: assessment.health === 'missing' || assessment.health === 'offline'
        ? 'warning'
        : 'info',
      title,
      detail,
      reason: detail,
      nodeId: assessment.nodeId,
      health: assessment.health,
      status: assessment.status ?? null,
      candidate: assessment.candidate === true,
      blockers: assessment.blockers,
      consecutiveUnhealthy,
      day,
      requiresDecision: false,
      scheduleId: ctx.scheduleId ?? null,
      runId: ctx.runId ?? null,
    },
  });
}
