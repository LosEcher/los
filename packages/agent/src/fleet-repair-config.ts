/**
 * Fleet repair configuration (global layer) + shared Zod schemas + audit.
 *
 * Precedence per gate field:
 *   per-node node_recovery_policy  >  global fleet_repair_config (DB)
 *   >  env (LOS_FLEET_REPAIR_*)  >  built-in defaults.
 *
 * The DB global layer exists so operator-tuned gates survive restarts and can
 * change at runtime without editing .env; env remains the boot-time override
 * and the built-in default is the last-resort baseline. Every mutation writes
 * an ops.config_changed session event (before/after) for auditability.
 */

import { z } from '@los/infra/zod';
import { getDb } from '@los/infra/db';
import type { GlobalRepairConfig } from './node-recovery-policy.js';
import { appendSessionEvent } from './session-events.js';

// ── Zod schemas (configuration truth, fail-closed on invalid input) ──

export const repairGateFieldsSchema = z.object({
  autoRepair: z.boolean().nullish(),
  cooldownMs: z.number().int().positive().nullish(),
  maxConsecutiveFailures: z.number().int().positive().nullish(),
  quorumThreshold: z.number().min(0).max(1).nullish(),
  restartUnhealthy: z.boolean().nullish(),
});
export type RepairGateFields = z.infer<typeof repairGateFieldsSchema>;

// Per-node policy uses its own field names (repairEnabled, supervisor) — the
// same gate semantics as the global schema but a separate shape.
export const nodeRecoveryPolicyPatchSchema = z.object({
  supervisor: z.string().min(1).nullish(),
  repairEnabled: z.boolean().nullish(),
  cooldownMs: z.number().int().positive().nullish(),
  maxConsecutiveFailures: z.number().int().positive().nullish(),
  quorumThreshold: z.number().min(0).max(1).nullish(),
  restartUnhealthy: z.boolean().nullish(),
});
export type NodeRecoveryPolicyPatchZ = z.infer<typeof nodeRecoveryPolicyPatchSchema>;

// ── global store (singleton row, id = 1) ──

export interface FleetRepairConfig {
  autoRepair: boolean | null;
  cooldownMs: number | null;
  maxConsecutiveFailures: number | null;
  quorumThreshold: number | null;
  restartUnhealthy: boolean | null;
  updatedAt: string;
}

export interface ConfigChangeMeta {
  operator?: string;
  source?: string;
  tenantId?: string;
  projectId?: string;
  runId?: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS fleet_repair_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  auto_repair BOOLEAN,
  cooldown_ms INTEGER,
  max_consecutive_failures INTEGER,
  quorum_threshold REAL,
  restart_unhealthy BOOLEAN,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

let _initialized = false;

export async function ensureFleetRepairConfigStore(): Promise<void> {
  if (_initialized) return;
  await getDb().exec(SCHEMA);
  _initialized = true;
}

export function _resetFleetRepairConfigStoreForTests(): void {
  _initialized = false;
}

interface ConfigRow {
  id: number;
  auto_repair: boolean | null;
  cooldown_ms: number | null;
  max_consecutive_failures: number | null;
  quorum_threshold: number | null;
  restart_unhealthy: boolean | null;
  updated_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function rowToConfig(row: ConfigRow): FleetRepairConfig {
  return {
    autoRepair: row.auto_repair,
    cooldownMs: row.cooldown_ms,
    maxConsecutiveFailures: row.max_consecutive_failures,
    quorumThreshold: row.quorum_threshold,
    restartUnhealthy: row.restart_unhealthy,
    updatedAt: toIso(row.updated_at),
  };
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
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

export async function loadFleetRepairConfig(): Promise<FleetRepairConfig | null> {
  await ensureFleetRepairConfigStore();
  const db = getDb();
  const rows = await db.query<ConfigRow>('SELECT * FROM fleet_repair_config WHERE id = 1');
  return rows.rows[0] ? rowToConfig(rows.rows[0]) : null;
}

/**
 * Upsert the global config. Unknown fields are rejected by Zod (fail-closed);
 * undefined fields keep their current value; explicit null clears a field back
 * to env/default fallback. Writes an ops.config_changed audit event.
 */
export async function upsertFleetRepairConfig(
  patch: RepairGateFields,
  meta: ConfigChangeMeta = {},
): Promise<FleetRepairConfig> {
  const parsed = repairGateFieldsSchema.parse(patch); // throws on invalid input
  await ensureFleetRepairConfigStore();
  const before = await loadFleetRepairConfig();
  const db = getDb();
  const rows = await db.query<ConfigRow>(
    `INSERT INTO fleet_repair_config
       (id, auto_repair, cooldown_ms, max_consecutive_failures, quorum_threshold,
        restart_unhealthy, updated_at)
     VALUES (1, $1, $2, $3, $4, $5, now())
     ON CONFLICT (id) DO UPDATE SET
       auto_repair = COALESCE(EXCLUDED.auto_repair, fleet_repair_config.auto_repair),
       cooldown_ms = COALESCE(EXCLUDED.cooldown_ms, fleet_repair_config.cooldown_ms),
       max_consecutive_failures = COALESCE(EXCLUDED.max_consecutive_failures, fleet_repair_config.max_consecutive_failures),
       quorum_threshold = COALESCE(EXCLUDED.quorum_threshold, fleet_repair_config.quorum_threshold),
       restart_unhealthy = COALESCE(EXCLUDED.restart_unhealthy, fleet_repair_config.restart_unhealthy),
       updated_at = now()
     RETURNING *`,
    [
      parsed.autoRepair === undefined ? null : parsed.autoRepair,
      parsed.cooldownMs === undefined ? null : parsed.cooldownMs,
      parsed.maxConsecutiveFailures === undefined ? null : parsed.maxConsecutiveFailures,
      parsed.quorumThreshold === undefined ? null : parsed.quorumThreshold,
      parsed.restartUnhealthy === undefined ? null : parsed.restartUnhealthy,
    ],
  );
  const after = rowToConfig(assertRow(rows.rows[0]));
  await auditConfigChange({
    scope: 'fleet_repair_config',
    fields: Object.keys(parsed),
    before: before ? { ...before } : null,
    after: { ...after },
    ...meta,
  }).catch(() => undefined);
  return after;
}

/** Delete the global row → all gates fall back to env/default. */
export async function clearFleetRepairConfig(meta: ConfigChangeMeta = {}): Promise<boolean> {
  await ensureFleetRepairConfigStore();
  const before = await loadFleetRepairConfig();
  const db = getDb();
  const rows = await db.query(
    'DELETE FROM fleet_repair_config WHERE id = 1 RETURNING id',
  );
  const removed = rows.rows.length > 0;
  if (removed) {
    await auditConfigChange({
      scope: 'fleet_repair_config',
      fields: ['*'],
      before: before ? { ...before } : null,
      after: null,
      ...meta,
    }).catch(() => undefined);
  }
  return removed;
}

// ── env parsing ──

function envBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const t = value.trim().toLowerCase();
  if (t === 'true' || t === '1') return true;
  if (t === 'false' || t === '0') return false;
  return undefined;
}

function envNumber(value: string | undefined): number | undefined {
  if (value === undefined || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Merge global config source chain: DB row (non-null fields) > env > defaults.
 * The result is what runFleetHostChecks passes as the global layer before the
 * per-node policy merge.
 */
export async function resolveGlobalRepairConfig(
  env: NodeJS.ProcessEnv = process.env,
  defaults: GlobalRepairConfig,
): Promise<GlobalRepairConfig> {
  const db = await loadFleetRepairConfig().catch(() => null);
  return {
    autoRepair: db?.autoRepair ?? envBoolean(env.LOS_FLEET_AUTO_REPAIR) ?? defaults.autoRepair,
    repairCooldownMs: db?.cooldownMs
      ?? envNumber(env.LOS_FLEET_REPAIR_COOLDOWN_MS)
      ?? defaults.repairCooldownMs,
    repairMaxConsecutiveFailures: db?.maxConsecutiveFailures
      ?? envNumber(env.LOS_FLEET_REPAIR_MAX_CONSECUTIVE_FAILURES)
      ?? defaults.repairMaxConsecutiveFailures,
    restartUnhealthy: db?.restartUnhealthy
      ?? envBoolean(env.LOS_FLEET_REPAIR_RESTART_UNHEALTHY)
      ?? defaults.restartUnhealthy,
    quorumThreshold: db?.quorumThreshold
      ?? envNumber(env.LOS_FLEET_REPAIR_QUORUM_THRESHOLD)
      ?? defaults.quorumThreshold,
  };
}

// ── audit ──

export interface ConfigChangeAuditInput extends ConfigChangeMeta {
  scope:
    | 'fleet_repair_config'
    | 'node_recovery_policy'
    | 'node_maintenance_policy'
    | 'fleet_alert_config';
  nodeId?: string;
  fields: string[];
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/** Write an ops.config_changed audit event; never throws to the caller. */
export async function auditConfigChange(input: ConfigChangeAuditInput): Promise<void> {
  await appendSessionEvent({
    sessionId: input.nodeId
      ? `ops:config:${input.scope}:${input.nodeId}`
      : `ops:config:${input.scope}`,
    type: 'ops.config_changed',
    source: 'ops',
    tenantId: input.tenantId?.trim() || 'local',
    projectId: input.projectId?.trim() || 'los',
    payload: {
      kind: 'config_changed',
      severity: 'info',
      title: `配置变更: ${input.scope}${input.nodeId ? `:${input.nodeId}` : ''}`,
      detail: `fields=${input.fields.join(',')}`,
      reason: `fields=${input.fields.join(',')}`,
      scope: input.scope,
      nodeId: input.nodeId ?? null,
      fields: input.fields,
      before: input.before,
      after: input.after,
      operator: input.operator ?? null,
      source: input.source ?? 'unknown',
      runId: input.runId ?? null,
      requiresDecision: false,
    },
  });
}

function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('fleet_repair_config write failed');
  return row;
}
