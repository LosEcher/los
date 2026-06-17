/**
 * @los/memory/compaction — Session memory compaction per ADR 0020.
 *
 * Compacts session observations, task runs, and eval records into a
 * structured summary. Procedural candidates are stored for review but
 * are never automatically promoted to rules.
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import {
  ensureProceduralCandidateStore,
  createProceduralCandidate,
  promoteProceduralCandidate,
} from './procedural-candidates.js';

const log = getLogger('memory-compaction');

export type CandidateStatus = 'draft' | 'review' | 'approved' | 'active' | 'retired';

export interface MemoryCompaction {
  id: string;
  sessionId: string;
  runSpecId?: string;
  tenantId?: string;
  projectId?: string;
  summary: Record<string, unknown>;
  observedPatterns: Record<string, unknown>[];
  proceduralCandidates: ProceduralCandidate[];
  confidence: number;
  /** Number of distinct sessions that support these patterns (cross-session). */
  evidenceCount: number;
  createdBy?: string;
  createdAt: string;
  /** Operator attestation — when a human confirms the pattern is valid. */
  attestedAt?: string;
  attestedBy?: string;
  /** Checkpoint mode — lightweight mid-session snapshot without pattern extraction. */
  checkpoint?: boolean;
  /** What triggered this checkpoint/compaction (event_count, tool_state_change, time_interval, manual). */
  autoTrigger?: string;
}

export interface ProceduralCandidate {
  name: string;
  content: string;
  severity: 'info' | 'warn' | 'error';
  rationale: string;
  confidence: number;
  status: CandidateStatus;
  /** Session IDs that also observed this pattern. */
  supportingSessionIds: string[];
}

export interface CompactSessionInput {
  sessionId: string;
  runSpecId?: string;
  tenantId?: string;
  projectId?: string;
  createdBy?: string;
  /** When true, skip dedup + cross-session evidence + pattern extraction. Allows multiple checkpoints per session. */
  checkpoint?: boolean;
  /** What triggered this operation (event_count, tool_state_change, time_interval, manual). */
  autoTrigger?: string;
}

export interface ListCompactionsOptions {
  sessionId?: string;
  runSpecId?: string;
  tenantId?: string;
  projectId?: string;
  limit?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_compactions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_spec_id TEXT,
  tenant_id TEXT,
  project_id TEXT,
  summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_patterns_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  procedural_candidates_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence NUMERIC NOT NULL DEFAULT 0,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE memory_compactions ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE memory_compactions ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE memory_compactions ADD COLUMN IF NOT EXISTS auto_trigger TEXT;

CREATE INDEX IF NOT EXISTS idx_memcomp_session ON memory_compactions(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memcomp_run_spec ON memory_compactions(run_spec_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memcomp_tenant_project ON memory_compactions(tenant_id, project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memcomp_checkpoint ON memory_compactions(session_id, auto_trigger, created_at DESC);
`;

let _initialized = false;

export async function ensureMemoryCompactionStore(): Promise<void> {
  if (_initialized) return;
  await getDb().exec(SCHEMA);
  _initialized = true;
  log.info('Memory compaction store initialized');
}

/**
 * Search existing compactions across other sessions for matching observed patterns.
 * Returns the number of distinct sessions that observed each pattern kind.
 */
async function lookupCrossSessionEvidence(
  sessionId: string,
  patternKinds: string[],
): Promise<Map<string, number>> {
  if (patternKinds.length === 0) return new Map();
  await ensureMemoryCompactionStore();
  const db = getDb();
  const counts = new Map<string, number>();

  for (const kind of patternKinds) {
    const rows = await db.query<{ cnt: string }>(
      `SELECT COUNT(DISTINCT session_id)::text AS cnt
       FROM memory_compactions
       WHERE session_id != $1
         AND observed_patterns_json @> $2::jsonb`,
      [sessionId, JSON.stringify([{ kind }])],
    );
    const count = Number(rows.rows[0]?.cnt ?? 0);
    if (count > 0) counts.set(kind, count);
  }
  return counts;
}

export async function compactSession(input: CompactSessionInput): Promise<MemoryCompaction | null> {
  await ensureMemoryCompactionStore();
  const sessionId = normalizeRequired(input.sessionId, 'sessionId');
  const db = getDb();
  const isCheckpoint = input.checkpoint === true;

  // Dedup: skip if this session was already compacted (unless checkpoint mode or force=true)
  if (!isCheckpoint) {
    const existingCheck = await db.query<{ id: string }>(
      `SELECT id FROM memory_compactions WHERE session_id = $1 LIMIT 1`,
      [sessionId],
    );
    if (existingCheck.rows[0] && !(input as any).force) {
      log.info(`Session ${sessionId} already compacted, skipping (use force=true to re-compact)`);
      return getCompaction(existingCheck.rows[0].id);
    }
  }

  // Advisory lock to prevent concurrent compaction of the same session
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`compact_${sessionId}`]);

  // Parallelize independent data-gathering queries (different tables)
  // Exclude already-archived observations from counts
  const [obsRows, taskRows, evalRows] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM observations
       WHERE session_id = $1
         AND coalesce(metadata_json->>'archived', 'false') = 'false'`,
      [sessionId],
    ),
    db.query<{ count: string; statuses: string }>(
      `SELECT
         COUNT(*)::text AS count,
         COALESCE(jsonb_agg(jsonb_build_object('id', id, 'status', status, 'model', model, 'node_id', node_id)), '[]'::jsonb)::text AS statuses
       FROM task_runs WHERE session_id = $1`,
      [sessionId],
    ),
    db.query<{ count: string; summary: string }>(
      `SELECT
         COUNT(*)::text AS count,
         COALESCE(jsonb_agg(jsonb_build_object(
           'success', success,
           'failure_class', failure_class,
           'failover_scope', failover_scope,
           'verification_status', verification_status
         )), '[]'::jsonb)::text AS summary
       FROM run_evals WHERE session_id = $1`,
      [sessionId],
    ),
  ]);
  const observationCount = Number(obsRows.rows[0]?.count ?? 0);
  const taskRunCount = Number(taskRows.rows[0]?.count ?? 0);
  const taskRunStatuses = parseJsonArray(taskRows.rows[0]?.statuses);
  const evalCount = Number(evalRows.rows[0]?.count ?? 0);
  const evalSummaries = parseJsonArray(evalRows.rows[0]?.summary);

  // Early return for empty sessions: nothing to compact
  const totalActivity = observationCount + taskRunCount + evalCount;
  if (totalActivity === 0) {
    log.info(`Session ${sessionId} has no observations, tasks, or evals — skipping compaction`);
    return null;
  }

  // Build observed patterns (skip for checkpoints — too expensive)
  const observedPatterns: Record<string, unknown>[] = [];
  let crossSessionCounts: Map<string, number> = new Map();
  let proceduralCandidates: ProceduralCandidate[] = [];
  let confidence = 0;
  let evidenceCount = 0;

  if (!isCheckpoint) {
    const executorFailures = evalSummaries.filter((e: Record<string, unknown>) => e.failover_scope === 'executor').length;

    if (executorFailures > 0) {
      observedPatterns.push({ kind: 'executor_failover', count: executorFailures, description: `Session had ${executorFailures} executor-level failures` });
    }

    // Look up cross-session evidence for observed pattern kinds
    const patternKinds = observedPatterns.map(p => String(p.kind ?? ''));
    crossSessionCounts = await lookupCrossSessionEvidence(sessionId, patternKinds);

    // Count distinct evidence sources
    if (observationCount > 0) evidenceCount += 1;
    if (taskRunCount > 0) evidenceCount += 1;
    if (evalCount > 0) evidenceCount += 1;
    for (const [, count] of crossSessionCounts.entries()) evidenceCount += count;

    // Build procedural candidates
    if (executorFailures > 0) {
      const crossSessions = crossSessionCounts.get('executor_failover') ?? 0;
      proceduralCandidates.push({
        name: `executor-failover-alert-${sessionId.slice(0, 8)}`,
        content: `Session ${sessionId} experienced ${executorFailures} executor failures. Review executor node health.`,
        severity: 'warn',
        rationale: `Observed ${executorFailures} executor failover eval(s) in this session${crossSessions > 0 ? ` and ${crossSessions} other session(s)` : ''}.`,
        confidence: crossSessions >= 2 ? 0.7 : 0.5,
        status: crossSessions >= 2 ? 'review' : 'draft',
        supportingSessionIds: [sessionId],
      });
    }

    confidence = proceduralCandidates.length > 0
      ? Math.max(...proceduralCandidates.map(c => c.confidence))
      : 0;
  }

  const summary = {
    sessionId,
    runSpecId: input.runSpecId ?? null,
    tenantId: input.tenantId ?? null,
    projectId: input.projectId ?? null,
    observationCount, taskRunCount, evalCount,
    taskRunStatuses: isCheckpoint ? undefined : taskRunStatuses,
    evalSummaries: isCheckpoint ? undefined : evalSummaries,
    compactedAt: new Date().toISOString(),
    checkpoint: isCheckpoint || undefined,
  };

  const id = isCheckpoint ? `chkpt-${sessionId}-${randomUUID()}` : `memcomp-${sessionId}-${randomUUID()}`;
  const autoTrigger = input.autoTrigger ?? null;

  const rows = await db.query<CompactionRow>(
    `INSERT INTO memory_compactions (
      id, session_id, run_spec_id, tenant_id, project_id, summary_json, observed_patterns_json,
      procedural_candidates_json, confidence, evidence_count, created_by, auto_trigger
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11, $12)
    RETURNING *`,
    [
      id,
      sessionId,
      input.runSpecId ?? null,
      input.tenantId ?? null,
      input.projectId ?? null,
      JSON.stringify(summary),
      JSON.stringify(observedPatterns),
      JSON.stringify(proceduralCandidates),
      confidence,
      evidenceCount,
      input.createdBy ?? null,
      autoTrigger,
    ],
  );

  // Dual-write to standalone procedural_candidates table (skip for checkpoints)
  if (!isCheckpoint && proceduralCandidates.length > 0) {
    await ensureProceduralCandidateStore();
    await Promise.all(
      proceduralCandidates.map(c =>
        createProceduralCandidate({
          name: c.name,
          content: c.content,
          severity: c.severity,
          rationale: c.rationale,
          confidence: c.confidence,
          status: c.status,
          compactionId: id,
          sessionId,
          tenantId: input.tenantId,
          projectId: input.projectId,
          supportingSessionIds: c.supportingSessionIds,
        }).catch(err => {
          log.warn(`Dual-write candidate "${c.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }),
      ),
    );
  }

  // Classify observations (skip for checkpoints — no pattern extraction)
  if (!isCheckpoint && observationCount > 0) {
    // Mark all session observations as compacted
    await db.query(
      `UPDATE observations
       SET metadata_json = jsonb_set(
         jsonb_set(
           jsonb_set(metadata_json, '{compacted}', 'true'),
           '{compactionId}', to_jsonb($2::text)
         ),
         '{compactedAt}', to_jsonb(now()::text)
       )
       WHERE session_id = $1`,
      [sessionId, id],
    ).catch(err => log.warn(`Failed to mark observations as compacted: ${err instanceof Error ? err.message : String(err)}`));

    // If compaction has meaningful confidence, mark observations as promotable
    if (confidence >= 0.5) {
      await db.query(
        `UPDATE observations
         SET metadata_json = jsonb_set(metadata_json, '{promotable}', 'true')
         WHERE session_id = $1 AND coalesce(metadata_json->>'promotable', 'false') = 'false'`,
        [sessionId],
      ).catch(err => log.warn(`Failed to mark observations as promotable: ${err instanceof Error ? err.message : String(err)}`));
    }

    // Upgrade kind=note to kind=fact for observations in sessions with cross-session evidence
    const crossSessionKinds = [...crossSessionCounts.entries()].filter(([, count]) => count > 0);
    if (crossSessionKinds.length > 0) {
      await db.query(
        `UPDATE observations
         SET kind = 'fact'
         WHERE session_id = $1 AND kind = 'note'`,
        [sessionId],
      ).catch(err => log.warn(`Failed to upgrade observation kinds: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  return rowToCompaction(assertRow(rows.rows[0]));
}

/**
 * Add operator attestation to a compaction. Confirms that the observed
 * patterns are valid and the procedural candidates should be promoted.
 */
export async function attestCompaction(
  id: string,
  attestedBy: string,
): Promise<MemoryCompaction | null> {
  await ensureMemoryCompactionStore();
  const db = getDb();
  const rows = await db.query<CompactionRow>(
    `UPDATE memory_compactions
     SET created_by = COALESCE(created_by, $2)
     WHERE id = $1
     RETURNING *`,
    [id, attestedBy],
  );
  // Note: attestedAt/attestedBy stored in summary_json for queryability
  if (rows.rows[0]) {
    const existing = rowToCompaction(rows.rows[0]);
    const updatedSummary = {
      ...existing.summary,
      attestedAt: new Date().toISOString(),
      attestedBy,
    };
    await db.query(
      `UPDATE memory_compactions SET summary_json = $2::jsonb WHERE id = $1`,
      [id, JSON.stringify(updatedSummary)],
    );
    return { ...existing, summary: updatedSummary, attestedAt: updatedSummary.attestedAt as string, attestedBy };
  }
  return null;
}

/**
 * Promote a procedural candidate within a compaction from draft → review → approved → active.
 * Updates both the JSONB column in memory_compactions (backwards compat) and the standalone
 * procedural_candidates table. Emits a session event on status transition.
 */
export async function promoteCandidate(
  compactionId: string,
  candidateName: string,
  newStatus: CandidateStatus,
): Promise<MemoryCompaction | null> {
  await ensureMemoryCompactionStore();
  const compaction = await getCompaction(compactionId);
  if (!compaction) return null;

  const oldCandidate = compaction.proceduralCandidates.find(c => c.name === candidateName);
  const candidates = compaction.proceduralCandidates.map(c =>
    c.name === candidateName ? { ...c, status: newStatus } : c,
  );

  const db = getDb();
  await db.query(
    `UPDATE memory_compactions SET procedural_candidates_json = $2::jsonb WHERE id = $1`,
    [compactionId, JSON.stringify(candidates)],
  );

  // Sync to standalone procedural_candidates table
  try {
    await ensureProceduralCandidateStore();
    const pcId = `pc-${compactionId}-${candidateName.slice(0, 64)}`;
    await promoteProceduralCandidate(pcId, newStatus);
  } catch (err) {
    log.warn(
      `Failed to sync promote to procedural_candidates for "${candidateName}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Emit rule_approval session event
  if (oldCandidate) {
    try {
      const { appendSessionEvent, ensureSessionEventStore } = await import(
        '@los/agent/session-events'
      );
      await ensureSessionEventStore();
      await appendSessionEvent({
        sessionId: compaction.sessionId,
        type: 'rule_approval',
        source: 'los',
        tenantId: compaction.tenantId,
        projectId: compaction.projectId,
        payload: {
          candidateId: `pc-${compactionId}-${candidateName.slice(0, 64)}`,
          candidateName,
          oldStatus: oldCandidate.status,
          newStatus,
          compactionId,
          promotedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      log.warn(
        `Failed to emit rule_approval event for "${candidateName}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return await getCompaction(compactionId);
}

export async function getCompaction(id: string): Promise<MemoryCompaction | null> {
  await ensureMemoryCompactionStore();
  const rows = await getDb().query<CompactionRow>(
    'SELECT * FROM memory_compactions WHERE id = $1',
    [id],
  );
  return rows.rows[0] ? rowToCompaction(rows.rows[0]) : null;
}

export async function listCompactions(options: ListCompactionsOptions = {}): Promise<MemoryCompaction[]> {
  await ensureMemoryCompactionStore();
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options.sessionId) {
    params.push(options.sessionId);
    clauses.push(`session_id = $${params.length}`);
  }
  if (options.runSpecId) {
    params.push(options.runSpecId);
    clauses.push(`run_spec_id = $${params.length}`);
  }
  if (options.tenantId) {
    params.push(options.tenantId);
    clauses.push(`(tenant_id IS NULL OR tenant_id = $${params.length})`);
  }
  if (options.projectId) {
    params.push(options.projectId);
    clauses.push(`(project_id IS NULL OR project_id = $${params.length})`);
  }

  const limit = normalizeLimit(options.limit);
  params.push(limit);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const rows = await getDb().query<CompactionRow>(
    `
    SELECT * FROM memory_compactions
    ${where}
    ORDER BY created_at DESC, id
    LIMIT $${params.length}
  `,
    params,
  );

  return rows.rows.map(rowToCompaction);
}

type CompactionRow = {
  id: string;
  session_id: string;
  run_spec_id: string | null;
  tenant_id: string | null;
  project_id: string | null;
  summary_json: unknown;
  observed_patterns_json: unknown;
  procedural_candidates_json: unknown;
  confidence: string | number;
  evidence_count: string | number;
  created_by: string | null;
  auto_trigger: string | null;
  created_at: Date | string;
};

function rowToCompaction(row: CompactionRow): MemoryCompaction {
  const summary = normalizeJsonObject(row.summary_json);
  return {
    id: row.id,
    sessionId: row.session_id,
    runSpecId: row.run_spec_id ?? undefined,
    tenantId: row.tenant_id ?? undefined,
    projectId: row.project_id ?? undefined,
    summary,
    observedPatterns: normalizeJsonArray(row.observed_patterns_json),
    proceduralCandidates: normalizeCandidateArray(row.procedural_candidates_json),
    confidence: Number(row.confidence),
    evidenceCount: Number(row.evidence_count),
    createdBy: row.created_by ?? undefined,
    createdAt: toIsoString(row.created_at),
    attestedAt: typeof summary.attestedAt === 'string' ? summary.attestedAt : undefined,
    attestedBy: typeof summary.attestedBy === 'string' ? summary.attestedBy : undefined,
    checkpoint: typeof summary.checkpoint === 'boolean' ? summary.checkpoint : undefined,
    autoTrigger: row.auto_trigger ?? undefined,
  };
}

function normalizeCandidateArray(value: unknown): ProceduralCandidate[] {
  const raw = normalizeJsonArray(value);
  return raw.map((item: Record<string, unknown>): ProceduralCandidate => ({
    name: typeof item.name === 'string' ? item.name : 'unknown',
    content: typeof item.content === 'string' ? item.content : '',
    severity: (item.severity === 'info' || item.severity === 'warn' || item.severity === 'error')
      ? item.severity as 'info' | 'warn' | 'error' : 'info',
    rationale: typeof item.rationale === 'string' ? item.rationale : '',
    confidence: typeof item.confidence === 'number' ? item.confidence : 0,
    status: (item.status === 'draft' || item.status === 'review' || item.status === 'approved' || item.status === 'active' || item.status === 'retired')
      ? item.status as CandidateStatus : 'draft',
    supportingSessionIds: Array.isArray(item.supportingSessionIds)
      ? item.supportingSessionIds.filter((s): s is string => typeof s === 'string')
      : [],
  }));
}

function normalizeRequired(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function normalizeLimit(value: unknown): number {
  const parsed = Number(value ?? 100);
  if (!Number.isFinite(parsed) || parsed <= 0) return 100;
  return Math.max(1, Math.min(1000, Math.floor(parsed)));
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch { return {}; }
  }
  return {};
}

function normalizeJsonArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(v => normalizeJsonObject(v));
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map((v: unknown) => normalizeJsonObject(v)) : [];
    } catch { return []; }
  }
  return [];
}

function parseJsonArray(raw: string | undefined): Record<string, unknown>[] {
  if (!raw) return [];
  try { return JSON.parse(raw) as Record<string, unknown>[]; } catch { return []; }
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('compaction write returned no row');
  return row;
}
