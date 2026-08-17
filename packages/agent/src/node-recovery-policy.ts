/**
 * Node recovery policy (P1' declarative repair config).
 *
 * Per-node overrides for the fleet auto-repair gates, persisted in
 * node_recovery_policy. Resolution precedence per field:
 *   node policy  >  global (env / run options)  >  built-in default.
 *
 * A NULL policy field means "fall back to global". repair_enabled=false in a
 * policy row explicitly disables auto-repair for that node regardless of the
 * global LOS_FLEET_AUTO_REPAIR flag (hard per-node kill switch).
 */

import { getDb } from '@los/infra/db';
import {
  auditConfigChange,
  nodeRecoveryPolicyPatchSchema,
  type ConfigChangeMeta,
} from './fleet-repair-config.js';

export interface NodeRecoveryPolicy {
  nodeId: string;
  /** Supervisor kind for the node: nssm | systemd | launchd | os_supervisor. */
  supervisor: string;
  /** Per-node auto-repair switch. null = follow global LOS_FLEET_AUTO_REPAIR. */
  repairEnabled: boolean | null;
  cooldownMs: number | null;
  maxConsecutiveFailures: number | null;
  quorumThreshold: number | null;
  restartUnhealthy: boolean | null;
  updatedAt: string;
}

export interface ResolvedRepairConfig {
  autoRepair: boolean;
  repairCooldownMs: number;
  repairMaxConsecutiveFailures: number;
  restartUnhealthy: boolean;
  quorumThreshold: number;
}

export interface GlobalRepairConfig {
  autoRepair: boolean;
  repairCooldownMs: number;
  repairMaxConsecutiveFailures: number;
  restartUnhealthy: boolean;
  quorumThreshold: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS node_recovery_policy (
  node_id TEXT PRIMARY KEY,
  supervisor TEXT NOT NULL DEFAULT 'os_supervisor',
  repair_enabled BOOLEAN,
  cooldown_ms INTEGER,
  max_consecutive_failures INTEGER,
  quorum_threshold REAL,
  restart_unhealthy BOOLEAN,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

let _initialized = false;

export async function ensureNodeRecoveryPolicyStore(): Promise<void> {
  if (_initialized) return;
  await getDb().exec(SCHEMA);
  _initialized = true;
}

export function _resetNodeRecoveryPolicyStoreForTests(): void {
  _initialized = false;
}

interface PolicyRow {
  node_id: string;
  supervisor: string;
  repair_enabled: boolean | null;
  cooldown_ms: number | null;
  max_consecutive_failures: number | null;
  quorum_threshold: number | null;
  restart_unhealthy: boolean | null;
  updated_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function toNullableBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase();
    if (t === 'true' || t === '1') return true;
    if (t === 'false' || t === '0') return false;
  }
  return null;
}

function rowToPolicy(row: PolicyRow): NodeRecoveryPolicy {
  return {
    nodeId: row.node_id,
    supervisor: row.supervisor || 'os_supervisor',
    repairEnabled: toNullableBoolean(row.repair_enabled),
    cooldownMs: toNullableNumber(row.cooldown_ms),
    maxConsecutiveFailures: toNullableNumber(row.max_consecutive_failures),
    quorumThreshold: toNullableNumber(row.quorum_threshold),
    restartUnhealthy: toNullableBoolean(row.restart_unhealthy),
    updatedAt: toIso(row.updated_at),
  };
}

export async function loadNodeRecoveryPolicy(nodeId: string): Promise<NodeRecoveryPolicy | null> {
  await ensureNodeRecoveryPolicyStore();
  const db = getDb();
  const rows = await db.query<PolicyRow>(
    'SELECT * FROM node_recovery_policy WHERE node_id = $1',
    [nodeId],
  );
  return rows.rows[0] ? rowToPolicy(rows.rows[0]) : null;
}

export interface NodeRecoveryPolicyPatch {
  supervisor?: string;
  repairEnabled?: boolean | null;
  cooldownMs?: number | null;
  maxConsecutiveFailures?: number | null;
  quorumThreshold?: number | null;
  restartUnhealthy?: boolean | null;
}

export async function upsertNodeRecoveryPolicy(
  nodeId: string,
  patch: NodeRecoveryPolicyPatch = {},
  meta: ConfigChangeMeta = {},
): Promise<NodeRecoveryPolicy> {
  const parsed = nodeRecoveryPolicyPatchSchema.parse(patch); // throws on invalid input
  await ensureNodeRecoveryPolicyStore();
  const before = await loadNodeRecoveryPolicy(nodeId);
  const db = getDb();
  // Undefined patch fields stay untouched (COALESCE to existing value); to
  // clear a field back to global fallback, delete the policy row instead.
  const rows = await db.query<PolicyRow>(
    `INSERT INTO node_recovery_policy
       (node_id, supervisor, repair_enabled, cooldown_ms, max_consecutive_failures,
        quorum_threshold, restart_unhealthy, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (node_id) DO UPDATE SET
       supervisor = COALESCE(EXCLUDED.supervisor, node_recovery_policy.supervisor),
       repair_enabled = COALESCE(EXCLUDED.repair_enabled, node_recovery_policy.repair_enabled),
       cooldown_ms = COALESCE(EXCLUDED.cooldown_ms, node_recovery_policy.cooldown_ms),
       max_consecutive_failures = COALESCE(EXCLUDED.max_consecutive_failures, node_recovery_policy.max_consecutive_failures),
       quorum_threshold = COALESCE(EXCLUDED.quorum_threshold, node_recovery_policy.quorum_threshold),
       restart_unhealthy = COALESCE(EXCLUDED.restart_unhealthy, node_recovery_policy.restart_unhealthy),
       updated_at = now()
     RETURNING *`,
    [
      nodeId,
      parsed.supervisor ?? 'os_supervisor',
      parsed.repairEnabled === undefined ? null : parsed.repairEnabled,
      parsed.cooldownMs === undefined ? null : parsed.cooldownMs,
      parsed.maxConsecutiveFailures === undefined ? null : parsed.maxConsecutiveFailures,
      parsed.quorumThreshold === undefined ? null : parsed.quorumThreshold,
      parsed.restartUnhealthy === undefined ? null : parsed.restartUnhealthy,
    ],
  );
  const after = rowToPolicy(assertRow(rows.rows[0]));
  await auditConfigChange({
    scope: 'node_recovery_policy',
    nodeId,
    fields: Object.keys(parsed),
    before: before ? { ...before } : null,
    after: { ...after },
    ...meta,
  }).catch(() => undefined);
  return after;
}

export async function deleteNodeRecoveryPolicy(
  nodeId: string,
  meta: ConfigChangeMeta = {},
): Promise<boolean> {
  await ensureNodeRecoveryPolicyStore();
  const before = await loadNodeRecoveryPolicy(nodeId);
  const db = getDb();
  const rows = await db.query(
    'DELETE FROM node_recovery_policy WHERE node_id = $1 RETURNING node_id',
    [nodeId],
  );
  const removed = rows.rows.length > 0;
  if (removed) {
    await auditConfigChange({
      scope: 'node_recovery_policy',
      nodeId,
      fields: ['*'],
      before: before ? { ...before } : null,
      after: null,
      ...meta,
    }).catch(() => undefined);
  }
  return removed;
}

/**
 * Merge a node policy with global config. Precedence: node policy field (when
 * non-null) > global. A per-node repair_enabled=false is a hard kill switch
 * that overrides a global LOS_FLEET_AUTO_REPAIR=true.
 */
export function resolveRepairConfig(
  policy: NodeRecoveryPolicy | null,
  global: GlobalRepairConfig,
): ResolvedRepairConfig {
  const p = policy;
  const autoRepair = p?.repairEnabled === false
    ? false
    : (p?.repairEnabled ?? global.autoRepair);
  return {
    autoRepair,
    repairCooldownMs: p?.cooldownMs ?? global.repairCooldownMs,
    repairMaxConsecutiveFailures: p?.maxConsecutiveFailures ?? global.repairMaxConsecutiveFailures,
    restartUnhealthy: p?.restartUnhealthy ?? global.restartUnhealthy,
    quorumThreshold: p?.quorumThreshold ?? global.quorumThreshold,
  };
}

function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('Node recovery policy write failed');
  return row;
}
