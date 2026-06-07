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

const log = getLogger('memory-compaction');

export interface MemoryCompaction {
  id: string;
  sessionId: string;
  runSpecId?: string;
  summary: Record<string, unknown>;
  observedPatterns: Record<string, unknown>[];
  proceduralCandidates: Record<string, unknown>[];
  confidence: number;
  evidenceCount: number;
  createdBy?: string;
  createdAt: string;
}

export interface CompactSessionInput {
  sessionId: string;
  runSpecId?: string;
  createdBy?: string;
}

export interface ListCompactionsOptions {
  sessionId?: string;
  runSpecId?: string;
  limit?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_compactions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_spec_id TEXT,
  summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_patterns_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  procedural_candidates_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence NUMERIC NOT NULL DEFAULT 0,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memcomp_session ON memory_compactions(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memcomp_run_spec ON memory_compactions(run_spec_id, created_at DESC);
`;

let _initialized = false;

export async function ensureMemoryCompactionStore(): Promise<void> {
  if (_initialized) return;
  await getDb().exec(SCHEMA);
  _initialized = true;
  log.info('Memory compaction store initialized');
}

export async function compactSession(input: CompactSessionInput): Promise<MemoryCompaction> {
  await ensureMemoryCompactionStore();
  const sessionId = normalizeRequired(input.sessionId, 'sessionId');
  const db = getDb();

  // Parallelize independent data-gathering queries (different tables)
  const [obsRows, taskRows, evalRows] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM observations WHERE session_id = $1`,
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

  // Detect failover patterns
  const executorFailures = evalSummaries.filter(
    (e: Record<string, unknown>) => e.failover_scope === 'executor',
  ).length;

  // Build observed patterns
  const observedPatterns: Record<string, unknown>[] = [];
  if (executorFailures > 0) {
    observedPatterns.push({
      kind: 'executor_failover',
      count: executorFailures,
      description: `Session had ${executorFailures} executor-level failures`,
    });
  }

  // Count distinct evidence sources
  let evidenceCount = 0;
  if (observationCount > 0) evidenceCount += 1;
  if (taskRunCount > 0) evidenceCount += 1;
  if (evalCount > 0) evidenceCount += 1;

  const summary = {
    sessionId,
    runSpecId: input.runSpecId ?? null,
    observationCount,
    taskRunCount,
    evalCount,
    taskRunStatuses,
    evalSummaries,
    compactedAt: new Date().toISOString(),
  };

  // Build procedural candidates (stored for review, NEVER auto-promoted)
  const proceduralCandidates: Record<string, unknown>[] = [];
  if (executorFailures > 0) {
    proceduralCandidates.push({
      name: `executor-failover-alert-${sessionId.slice(0, 8)}`,
      content: `Session ${sessionId} experienced ${executorFailures} executor failures. Review executor node health.`,
      severity: 'warn',
      rationale: `Observed ${executorFailures} executor failover eval(s) in a single session.`,
      confidence: 0.5,
    });
  }

  const confidence = proceduralCandidates.length > 0 ? 0.5 : 0;

  const id = `memcomp-${sessionId}-${randomUUID()}`;
  const rows = await db.query<CompactionRow>(
    `
    INSERT INTO memory_compactions (
      id, session_id, run_spec_id, summary_json, observed_patterns_json,
      procedural_candidates_json, confidence, evidence_count, created_by
    )
    VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9)
    RETURNING *
  `,
    [
      id,
      sessionId,
      input.runSpecId ?? null,
      JSON.stringify(summary),
      JSON.stringify(observedPatterns),
      JSON.stringify(proceduralCandidates),
      confidence,
      evidenceCount,
      input.createdBy ?? null,
    ],
  );

  return rowToCompaction(assertRow(rows.rows[0]));
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
  summary_json: unknown;
  observed_patterns_json: unknown;
  procedural_candidates_json: unknown;
  confidence: string | number;
  evidence_count: string | number;
  created_by: string | null;
  created_at: Date | string;
};

function rowToCompaction(row: CompactionRow): MemoryCompaction {
  return {
    id: row.id,
    sessionId: row.session_id,
    runSpecId: row.run_spec_id ?? undefined,
    summary: normalizeJsonObject(row.summary_json),
    observedPatterns: normalizeJsonArray(row.observed_patterns_json),
    proceduralCandidates: normalizeJsonArray(row.procedural_candidates_json),
    confidence: Number(row.confidence),
    evidenceCount: Number(row.evidence_count),
    createdBy: row.created_by ?? undefined,
    createdAt: toIsoString(row.created_at),
  };
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
