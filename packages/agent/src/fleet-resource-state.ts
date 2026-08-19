/**
 * Fleet resource severity state — hysteresis memory (Komodo borrow P0-1).
 *
 * `fleet-resources.ts` evaluation stays pure; the previous severity per
 * (node, signal) lives here so threshold hysteresis can defer clearing a
 * warning/critical until the metric crosses back past the band. Same storage
 * pattern as fleet_watch_state: singleton per-node row, upsert, fail-soft.
 *
 * Design: docs/architecture/2026-08-19-komodo-borrow-p0-design.md §2
 */

import { getDb } from '@los/infra/db';

import type {
  FleetResourceFinding,
  FleetResourceSeverity,
  FleetResourceSignal,
} from './fleet-resources.js';

/** Per-signal severity map, e.g. { memory_available: 'critical' }. */
export type FleetResourceSeverityMap = Partial<
  Record<FleetResourceSignal, FleetResourceSeverity>
>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS fleet_resource_state (
  node_id TEXT PRIMARY KEY,
  severities JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

let _initialized = false;

export async function ensureFleetResourceStateStore(): Promise<void> {
  if (_initialized) return;
  await getDb().exec(SCHEMA);
  _initialized = true;
}

/** Test helper — next ensure recreates schema readiness. */
export function _resetFleetResourceStateStoreForTests(): void {
  _initialized = false;
}

interface SeverityRow {
  node_id: string;
  severities: string | Record<string, unknown>;
  updated_at: Date | string;
}

function parseSeverities(raw: string | Record<string, unknown> | null): FleetResourceSeverityMap {
  if (!raw) return {};
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const out: FleetResourceSeverityMap = {};
    for (const [signal, severity] of Object.entries(parsed)) {
      if (
        severity === 'warning'
        || severity === 'critical'
        || severity === undefined
        || severity === null
      ) {
        if (severity !== undefined && severity !== null) {
          out[signal as FleetResourceSignal] = severity;
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Batch load for the named fleet in one query. */
export async function loadFleetResourceSeveritiesBatch(
  nodeIds: string[],
): Promise<Record<string, FleetResourceSeverityMap>> {
  await ensureFleetResourceStateStore();
  if (nodeIds.length === 0) return {};
  const db = getDb();
  const placeholders = nodeIds.map((_, i) => `$${i + 1}`).join(',');
  const rows = await db.query<SeverityRow>(
    `SELECT node_id, severities FROM fleet_resource_state WHERE node_id IN (${placeholders})`,
    nodeIds,
  );
  const out: Record<string, FleetResourceSeverityMap> = {};
  for (const id of nodeIds) out[id] = {};
  for (const row of rows.rows) {
    out[row.node_id] = parseSeverities(row.severities);
  }
  return out;
}

export async function saveFleetResourceSeverities(
  nodeId: string,
  severities: FleetResourceSeverityMap,
): Promise<void> {
  await ensureFleetResourceStateStore();
  const db = getDb();
  await db.query(
    `INSERT INTO fleet_resource_state (node_id, severities, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (node_id) DO UPDATE SET
       severities = EXCLUDED.severities,
       updated_at = now()`,
    [nodeId, JSON.stringify(severities)],
  );
}

/**
 * Extract the current severity per signal from an evaluation's findings.
 * A signal appears at most once per node (if/else chain in the evaluator),
 * so the last occurrence wins by construction.
 */
export function extractSeveritiesFromFindings(
  findings: FleetResourceFinding[],
): FleetResourceSeverityMap {
  const out: FleetResourceSeverityMap = {};
  for (const finding of findings) {
    out[finding.signal] = finding.severity;
  }
  return out;
}
