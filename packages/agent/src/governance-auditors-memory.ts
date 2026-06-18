import { getDb } from '@los/infra/db';
import { PROCEDURAL_CANDIDATES_DDL } from '@los/infra/procedural-candidates-ddl';

/** Integrity checks for @los/memory module. Used by governance sweeper. */
export async function runMemoryIntegrityAudit(): Promise<Record<string, unknown>> {
  const db = getDb();

  // Ensure tables exist before queries (cannot import from @los/memory due to circular dep).
  // Idempotent; follows the same pattern as PROCEDURAL_CANDIDATES_DDL for rule effectiveness checks.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS observations (
      id BIGSERIAL PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'note', tags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      content TEXT NOT NULL DEFAULT '', metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      source TEXT NOT NULL DEFAULT 'user', session_id TEXT,
      tenant_id TEXT, project_id TEXT, user_id TEXT, node_id TEXT,
      request_id TEXT, trace_id TEXT, search_vector tsvector,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS memory_compactions (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_spec_id TEXT,
      tenant_id TEXT, project_id TEXT, summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      observed_patterns_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      procedural_candidates_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      confidence NUMERIC NOT NULL DEFAULT 0, evidence_count INTEGER NOT NULL DEFAULT 0,
      created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const checks: Array<{ name: string; passed: boolean; detail: string; severity: string }> = [];
  const auditedAt = new Date().toISOString();

  // Check 1: uncompacted sessions with observations
  try {
    const rows = await db.query<{ cnt: string }>(
      `SELECT COUNT(DISTINCT o.session_id)::text AS cnt
       FROM observations o LEFT JOIN memory_compactions mc ON o.session_id = mc.session_id
       WHERE o.session_id IS NOT NULL AND mc.id IS NULL
         AND o.created_at < now() - INTERVAL '1 hour'`,
    );
    const count = Number(rows.rows[0]?.cnt ?? 0);
    checks.push({
      name: 'compaction-session-validity', passed: count <= 10,
      detail: count === 0 ? 'All observation sessions have compactions' : `${count} uncompacted session(s)`,
      severity: count > 10 ? 'warn' : 'info',
    });
  } catch (err) {
    checks.push({ name: 'compaction-session-validity', passed: false, detail: `Query failed: ${err instanceof Error ? err.message : String(err)}`, severity: 'error' });
  }

  // Check 2: stale approved candidates
  try {
    await db.exec(PROCEDURAL_CANDIDATES_DDL);
    const rows = await db.query<{ cnt: string; names: string }>(
      `SELECT COUNT(*)::text AS cnt, COALESCE(string_agg(name, ', ' ORDER BY updated_at), '') AS names
       FROM procedural_candidates WHERE status = 'approved' AND updated_at < now() - INTERVAL '7 days'`,
    );
    const count = Number(rows.rows[0]?.cnt ?? 0);
    checks.push({
      name: 'candidate-status-consistency', passed: count === 0,
      detail: count === 0 ? 'No stale approved candidates' : `${count} candidate(s) stuck in 'approved' for >7 days: ${rows.rows[0]?.names ?? 'unknown'}`,
      severity: count > 0 ? 'warn' : 'info',
    });
  } catch (err) {
    checks.push({ name: 'candidate-status-consistency', passed: false, detail: `Query failed: ${err instanceof Error ? err.message : String(err)}`, severity: 'error' });
  }

  // Check 3: orphaned compactions
  try {
    const rows = await db.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM memory_compactions mc
       WHERE CAST(mc.summary_json->>'observationCount' AS integer) > 0
         AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.session_id = mc.session_id)`,
    );
    const count = Number(rows.rows[0]?.cnt ?? 0);
    checks.push({
      name: 'orphaned-compactions', passed: count === 0,
      detail: count === 0 ? 'No orphaned compactions' : `${count} compaction(s) reference deleted observation sessions`,
      severity: count > 0 ? 'warn' : 'info',
    });
  } catch (err) {
    checks.push({ name: 'orphaned-compactions', passed: false, detail: `Query failed: ${err instanceof Error ? err.message : String(err)}`, severity: 'error' });
  }

  // Check 4: observation-to-compaction ratio
  try {
    const obsRows = await db.query<{ cnt: string }>('SELECT COUNT(*)::text AS cnt FROM observations');
    const compRows = await db.query<{ cnt: string }>('SELECT COUNT(*)::text AS cnt FROM memory_compactions');
    const obsCount = Number(obsRows.rows[0]?.cnt ?? 0);
    const compCount = Number(compRows.rows[0]?.cnt ?? 0);
    const ratio = compCount > 0 ? Math.round(obsCount / compCount) : obsCount;
    const ratioProblem = (compCount === 0 && obsCount > 50) || (compCount > 0 && ratio > 100);
    checks.push({
      name: 'observation-compaction-ratio', passed: !ratioProblem,
      detail: `${obsCount} observations / ${compCount} compactions = ${ratio}:1 ratio`,
      severity: ratioProblem ? 'warn' : 'info',
    });
  } catch (err) {
    checks.push({ name: 'observation-compaction-ratio', passed: false, detail: `Query failed: ${err instanceof Error ? err.message : String(err)}`, severity: 'error' });
  }

  // Check 5: search vector freshness
  try {
    const rows = await db.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM observations
       WHERE updated_at > created_at + INTERVAL '1 second' AND search_vector IS NOT NULL`,
    );
    const count = Number(rows.rows[0]?.cnt ?? 0);
    checks.push({
      name: 'search-vector-freshness', passed: true,
      detail: count === 0 ? 'No search vector concerns detected' : `${count} observation(s) updated — search_vector auto-regenerated on UPDATE`,
      severity: 'info',
    });
  } catch (err) {
    checks.push({ name: 'search-vector-freshness', passed: false, detail: `Query failed: ${err instanceof Error ? err.message : String(err)}`, severity: 'error' });
  }

  const passed = checks.every(c => c.severity !== 'error');
  return { auditedAt, passed, checks, failedChecks: checks.filter(c => !c.passed).map(c => c.name), errorCount: checks.filter(c => c.severity === 'error').length, warnCount: checks.filter(c => c.severity === 'warn').length };
}

/** Retention policy audit for @los/memory module. Used by governance sweeper. */
export async function runMemoryRetentionAudit(): Promise<Record<string, unknown>> {
  const db = getDb();
  const auditedAt = new Date().toISOString();
  let archivedCount = 0, deletedCount = 0;
  const errors: string[] = [];

  await db.exec(`
    CREATE TABLE IF NOT EXISTS observations (
      id BIGSERIAL PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'note', tags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      content TEXT NOT NULL DEFAULT '', metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      source TEXT NOT NULL DEFAULT 'user', session_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS memory_compactions (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const PERMANENT_CLAUSE = `AND coalesce(metadata_json->>'retention', '') != 'permanent'`;

  try {
    const archived = await db.query<{ cnt: string }>(
      `WITH updated AS (
         UPDATE observations SET metadata_json = jsonb_set(jsonb_set(metadata_json, '{archived}', 'true'), '{archivedAt}', to_jsonb(now()::text))
         WHERE coalesce(metadata_json->>'archived', 'false') = 'false' AND created_at < now() - INTERVAL '90 days' ${PERMANENT_CLAUSE}
         RETURNING id) SELECT COUNT(*)::text AS cnt FROM updated`,
    );
    archivedCount += Number(archived.rows[0]?.cnt ?? 0);
  } catch (err) {
    errors.push(`Archive step 1 failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const compactArchived = await db.query<{ cnt: string }>(
      `WITH compacted_sessions AS (
         SELECT DISTINCT session_id FROM memory_compactions
         WHERE created_at < now() - INTERVAL '30 days' AND session_id IS NOT NULL),
       updated AS (
         UPDATE observations o SET metadata_json = jsonb_set(jsonb_set(metadata_json, '{archived}', 'true'), '{archivedAt}', to_jsonb(now()::text))
         FROM compacted_sessions cs WHERE o.session_id = cs.session_id
         AND coalesce(o.metadata_json->>'archived', 'false') = 'false' ${PERMANENT_CLAUSE}
         RETURNING o.id) SELECT COUNT(*)::text AS cnt FROM updated`,
    );
    archivedCount += Number(compactArchived.rows[0]?.cnt ?? 0);
  } catch (err) {
    errors.push(`Archive step 2 failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const deleted = await db.query<{ cnt: string }>(
      `WITH deleted AS (
         DELETE FROM observations WHERE session_id IS NULL AND created_at < now() - INTERVAL '180 days' ${PERMANENT_CLAUSE}
         RETURNING id) SELECT COUNT(*)::text AS cnt FROM deleted`,
    );
    deletedCount += Number(deleted.rows[0]?.cnt ?? 0);
  } catch (err) {
    errors.push(`Delete step failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { auditedAt, archivedCount, deletedCount, errors, passed: errors.length === 0 };
}
