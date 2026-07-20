import { createHash } from 'node:crypto';

import { getDb } from '@los/infra/db';

import { _buildEvidenceWindow } from './metrics.js';
import { ensureDailyAgentQualityStore } from './schema.js';
import type {
  DailyAgentQualityBaseline,
  DailyAgentQualityScope,
  DailyAgentQualitySnapshot,
} from './types.js';

export async function upsertDailyAgentQualitySnapshot(
  snapshot: Omit<DailyAgentQualitySnapshot, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<DailyAgentQualitySnapshot> {
  await ensureDailyAgentQualityStore();
  const id = snapshotId(snapshot.tenantId, snapshot.projectId, snapshot.snapshotDate);
  const rows = await getDb().query<DailyQualityRow>(
    `INSERT INTO daily_agent_quality_snapshots (
       id,tenant_id,project_id,snapshot_date,captured_at,window_start,window_end,
       inbox_json,schedule_json,recovery_json,verification_json,provider_quality_json
     ) VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb)
     ON CONFLICT (tenant_id,project_id,snapshot_date) DO UPDATE SET
       captured_at=EXCLUDED.captured_at,window_start=EXCLUDED.window_start,window_end=EXCLUDED.window_end,
       inbox_json=EXCLUDED.inbox_json,schedule_json=EXCLUDED.schedule_json,
       recovery_json=EXCLUDED.recovery_json,verification_json=EXCLUDED.verification_json,
       provider_quality_json=EXCLUDED.provider_quality_json,updated_at=now()
     RETURNING *`,
    [id, snapshot.tenantId, snapshot.projectId, snapshot.snapshotDate, snapshot.capturedAt,
      snapshot.windowStart, snapshot.windowEnd, JSON.stringify(snapshot.inbox),
      JSON.stringify(snapshot.schedule), JSON.stringify(snapshot.recovery),
      JSON.stringify(snapshot.verification), JSON.stringify(snapshot.providerQuality)],
  );
  return rowToSnapshot(rows.rows[0]!);
}

export async function getDailyAgentQualityBaseline(input: {
  tenantId?: string;
  projectId: string;
  requiredDays?: number;
  now?: Date;
}): Promise<DailyAgentQualityBaseline> {
  await ensureDailyAgentQualityStore();
  const tenantId = input.tenantId ?? 'local';
  const requiredDays = Math.min(90, Math.max(1, Math.floor(input.requiredDays ?? 28)));
  const expectedTo = (input.now ?? new Date()).toISOString().slice(0, 10);
  const expectedFrom = new Date(`${expectedTo}T00:00:00.000Z`);
  expectedFrom.setUTCDate(expectedFrom.getUTCDate() - requiredDays + 1);
  const rows = await getDb().query<DailyQualityRow>(
    `SELECT * FROM daily_agent_quality_snapshots
     WHERE tenant_id=$1 AND project_id=$2 AND snapshot_date BETWEEN $3::date AND $4::date
     ORDER BY snapshot_date DESC`,
    [tenantId, input.projectId, expectedFrom.toISOString().slice(0, 10), expectedTo],
  );
  const snapshots = rows.rows.map(rowToSnapshot);
  return {
    evidenceWindow: _buildEvidenceWindow(snapshots.map(item => item.snapshotDate), expectedTo, requiredDays),
    snapshots,
  };
}

export async function listDailyAgentQualityScopes(): Promise<DailyAgentQualityScope[]> {
  await ensureDailyAgentQualityStore();
  const rows = await getDb().query<{ tenant_id: string; project_id: string }>(
    `SELECT DISTINCT tenant_id,project_id FROM (
       SELECT COALESCE(tenant_id,'local') AS tenant_id,project_id FROM todos
       UNION SELECT COALESCE(tenant_id,'local'),project_id FROM run_specs
       UNION SELECT tenant_id,project_id FROM scheduled_work_items
       UNION SELECT tenant_id,project_id FROM daily_agent_quality_snapshots
     ) scopes WHERE project_id IS NOT NULL AND project_id <> ''
     ORDER BY tenant_id,project_id`,
  );
  return rows.rows.map(row => ({ tenantId: row.tenant_id, projectId: row.project_id }));
}

function snapshotId(tenantId: string, projectId: string, snapshotDate: string): string {
  const hash = createHash('sha256').update(`${tenantId}\0${projectId}\0${snapshotDate}`).digest('hex').slice(0, 24);
  return `daily-quality-${hash}`;
}

type DailyQualityRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  snapshot_date: Date | string;
  captured_at: Date | string;
  window_start: Date | string;
  window_end: Date | string;
  inbox_json: unknown;
  schedule_json: unknown;
  recovery_json: unknown;
  verification_json: unknown;
  provider_quality_json: unknown;
  created_at: Date | string;
  updated_at: Date | string;
};

function rowToSnapshot(row: DailyQualityRow): DailyAgentQualitySnapshot {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    snapshotDate: dateOnly(row.snapshot_date),
    capturedAt: toIso(row.captured_at),
    windowStart: toIso(row.window_start),
    windowEnd: toIso(row.window_end),
    inbox: row.inbox_json as DailyAgentQualitySnapshot['inbox'],
    schedule: row.schedule_json as DailyAgentQualitySnapshot['schedule'],
    recovery: row.recovery_json as DailyAgentQualitySnapshot['recovery'],
    verification: row.verification_json as DailyAgentQualitySnapshot['verification'],
    providerQuality: row.provider_quality_json as DailyAgentQualitySnapshot['providerQuality'],
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function dateOnly(value: Date | string): string {
  if (!(value instanceof Date)) return String(value).slice(0, 10);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
