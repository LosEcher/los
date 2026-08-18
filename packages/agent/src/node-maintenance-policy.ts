/**
 * Per-node maintenance windows (Komodo borrow P0-2).
 *
 * Absolute ISO time windows. While `now` falls inside any configured window,
 * fleet alerts / attention / host-check repair are suppressed for that node.
 * Same storage + audit pattern as node_recovery_policy: per-node singleton
 * row, Zod-validated (fail-closed), ops.config_changed audit on mutation.
 *
 * Design: docs/architecture/2026-08-19-komodo-borrow-p0-design.md §3
 */

import { z } from '@los/infra/zod';
import { getDb } from '@los/infra/db';

import {
  auditConfigChange,
  type ConfigChangeMeta,
} from './fleet-repair-config.js';

export const maintenanceWindowSchema = z
  .object({
    start: z.string().min(1),
    end: z.string().min(1),
  })
  .refine(
    (w) => {
      const s = Date.parse(w.start);
      const e = Date.parse(w.end);
      return Number.isFinite(s) && Number.isFinite(e) && s < e;
    },
    { message: 'maintenance window start/end must be parseable ISO timestamps with start < end' },
  );

export const nodeMaintenancePolicyPatchSchema = z.object({
  windows: z.array(maintenanceWindowSchema),
});
export type NodeMaintenancePolicyPatch = z.infer<typeof nodeMaintenancePolicyPatchSchema>;

export interface MaintenanceWindow {
  start: string;
  end: string;
}

export interface NodeMaintenancePolicy {
  nodeId: string;
  windows: MaintenanceWindow[];
  updatedAt: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS node_maintenance_policy (
  node_id TEXT PRIMARY KEY,
  windows JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

let _initialized = false;

export async function ensureNodeMaintenancePolicyStore(): Promise<void> {
  if (_initialized) return;
  await getDb().exec(SCHEMA);
  _initialized = true;
}

/** Test helper — next ensure recreates schema readiness. */
export function _resetNodeMaintenancePolicyStoreForTests(): void {
  _initialized = false;
}

interface PolicyRow {
  node_id: string;
  windows: string | MaintenanceWindow[];
  updated_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseWindows(raw: string | MaintenanceWindow[] | null): MaintenanceWindow[] {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (w): w is MaintenanceWindow =>
          !!w
          && typeof w === 'object'
          && typeof (w as MaintenanceWindow).start === 'string'
          && typeof (w as MaintenanceWindow).end === 'string',
      )
      .map((w) => ({ start: w.start, end: w.end }));
  } catch {
    return [];
  }
}

function rowToPolicy(row: PolicyRow): NodeMaintenancePolicy {
  return {
    nodeId: row.node_id,
    windows: parseWindows(row.windows),
    updatedAt: toIso(row.updated_at),
  };
}

export async function loadNodeMaintenancePolicy(
  nodeId: string,
): Promise<NodeMaintenancePolicy | null> {
  await ensureNodeMaintenancePolicyStore();
  const db = getDb();
  const rows = await db.query<PolicyRow>(
    'SELECT * FROM node_maintenance_policy WHERE node_id = $1',
    [nodeId],
  );
  return rows.rows[0] ? rowToPolicy(rows.rows[0]) : null;
}

/** Batch load for the named fleet in one query. */
export async function loadNodeMaintenancePoliciesBatch(
  nodeIds: string[],
): Promise<Record<string, NodeMaintenancePolicy | null>> {
  await ensureNodeMaintenancePolicyStore();
  if (nodeIds.length === 0) return {};
  const db = getDb();
  const placeholders = nodeIds.map((_, i) => `$${i + 1}`).join(',');
  const rows = await db.query<PolicyRow>(
    `SELECT * FROM node_maintenance_policy WHERE node_id IN (${placeholders})`,
    nodeIds,
  );
  const out: Record<string, NodeMaintenancePolicy | null> = {};
  for (const id of nodeIds) out[id] = null;
  for (const row of rows.rows) out[row.node_id] = rowToPolicy(row);
  return out;
}

export async function upsertNodeMaintenancePolicy(
  nodeId: string,
  patch: NodeMaintenancePolicyPatch,
  meta: ConfigChangeMeta = {},
): Promise<NodeMaintenancePolicy> {
  const parsed = nodeMaintenancePolicyPatchSchema.parse(patch); // throws on invalid input
  await ensureNodeMaintenancePolicyStore();
  const before = await loadNodeMaintenancePolicy(nodeId);
  const db = getDb();
  const rows = await db.query<PolicyRow>(
    `INSERT INTO node_maintenance_policy (node_id, windows, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (node_id) DO UPDATE SET
       windows = EXCLUDED.windows,
       updated_at = now()
     RETURNING *`,
    [nodeId, JSON.stringify(parsed.windows)],
  );
  const after = rowToPolicy(assertRow(rows.rows[0]));
  await auditConfigChange({
    scope: 'node_maintenance_policy',
    nodeId,
    fields: ['windows'],
    before: before ? { windows: before.windows } : null,
    after: { windows: after.windows },
    ...meta,
  }).catch(() => undefined);
  return after;
}

export async function deleteNodeMaintenancePolicy(
  nodeId: string,
  meta: ConfigChangeMeta = {},
): Promise<boolean> {
  await ensureNodeMaintenancePolicyStore();
  const before = await loadNodeMaintenancePolicy(nodeId);
  const db = getDb();
  const rows = await db.query(
    'DELETE FROM node_maintenance_policy WHERE node_id = $1 RETURNING node_id',
    [nodeId],
  );
  const removed = rows.rows.length > 0;
  if (removed) {
    await auditConfigChange({
      scope: 'node_maintenance_policy',
      nodeId,
      fields: ['*'],
      before: before ? { windows: before.windows } : null,
      after: null,
      ...meta,
    }).catch(() => undefined);
  }
  return removed;
}

/**
 * Pure window check. A null/empty policy is never in maintenance; the check
 * is inclusive on both boundaries so a window covers [start, end].
 */
export function isNodeInMaintenance(
  nodeId: string,
  now: Date | number,
  policy: NodeMaintenancePolicy | null,
): boolean {
  if (!policy || policy.windows.length === 0) return false;
  const nowMs = typeof now === 'number' ? now : now.getTime();
  return policy.windows.some((w) => {
    const s = Date.parse(w.start);
    const e = Date.parse(w.end);
    return Number.isFinite(s) && Number.isFinite(e) && nowMs >= s && nowMs <= e;
  });
}

function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('node_maintenance_policy write failed');
  return row;
}
