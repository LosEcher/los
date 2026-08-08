/**
 * @los/memory/checkpoint — Lightweight session checkpointing.
 *
 * Checkpoints are mid-session snapshots produced by compactSession()
 * with { checkpoint: true }. Unlike full compactions, checkpoints:
 * - Allow multiple per session (no dedup)
 * - Skip cross-session evidence lookup and pattern extraction
 * - Are tagged with auto_trigger indicating what triggered them
 */

import { getDb } from '@los/infra/db';
import {
  ensureMemoryCompactionStore,
  type MemoryCompaction,
} from './compaction.js';

/**
 * Get the most recent checkpoint for a session. Returns null if no
 * checkpoint or compaction exists for this session.
 *
 * Access-context options are REQUIRED from gateway routes: `tenantId` and
 * `projectId` scope the lookup so an authenticated user can never read a
 * checkpoint owned by another tenant/project (cross-tenant read guard).
 * NULL-owned rows (legacy/unattributed) stay visible, matching
 * listCompactions() semantics; attributed rows must match exactly.
 *
 * Fail-closed: when `options` is omitted entirely, only legacy rows with no
 * tenant/project ownership are visible — a future caller that forgets the
 * access context cannot read attributed rows again.
 */
export async function getLatestCheckpoint(
  sessionId: string,
  options?: { tenantId?: string | null; projectId?: string | null },
): Promise<MemoryCompaction | null> {
  await ensureMemoryCompactionStore();
  const scopeProvided = options !== undefined;
  const rows = await getDb().query<{
    id: string; session_id: string; run_spec_id: string | null;
    tenant_id: string | null; project_id: string | null;
    summary_json: unknown; observed_patterns_json: unknown;
    procedural_candidates_json: unknown; confidence: string | number;
    evidence_count: string | number; created_by: string | null;
    auto_trigger: string | null; created_at: Date | string;
  }>(
    `SELECT * FROM memory_compactions
     WHERE session_id = $1
       AND (tenant_id IS NULL OR ($2::boolean AND ($3::text IS NULL OR tenant_id = $3)))
       AND (project_id IS NULL OR ($2::boolean AND ($4::text IS NULL OR project_id = $4)))
     ORDER BY created_at DESC, id
     LIMIT 1`,
    [sessionId, scopeProvided, options?.tenantId ?? null, options?.projectId ?? null],
  );
  if (!rows.rows[0]) return null;

  // Inline row conversion to avoid circular import of rowToCompaction
  const row = rows.rows[0];
  const summary = typeof row.summary_json === 'object' && row.summary_json !== null && !Array.isArray(row.summary_json)
    ? row.summary_json as Record<string, unknown>
    : {};
  return {
    id: row.id,
    sessionId: row.session_id,
    runSpecId: row.run_spec_id ?? undefined,
    tenantId: row.tenant_id ?? undefined,
    projectId: row.project_id ?? undefined,
    summary,
    observedPatterns: [],
    proceduralCandidates: [],
    confidence: Number(row.confidence),
    evidenceCount: Number(row.evidence_count),
    createdBy: row.created_by ?? undefined,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at as string).toISOString(),
    checkpoint: typeof summary.checkpoint === 'boolean' ? summary.checkpoint : undefined,
    autoTrigger: row.auto_trigger ?? undefined,
  };
}
