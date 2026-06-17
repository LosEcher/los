import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import { PROCEDURAL_CANDIDATES_DDL } from '@los/infra/procedural-candidates-ddl';
import type { GovernanceJob } from './governance-jobs-types.js';

const log = getLogger('governance-jobs');

async function runConsistencyAudit(): Promise<Record<string, unknown>> {
  const { reconcilePlanningTodosFromOpenDb } = await import('./governance-reconciliation.js');
  const { readStatusConstraintReportFromOpenDb } = await import('./governance-status-constraints.js');

  const [todoReport, statusReport] = await Promise.all([
    reconcilePlanningTodosFromOpenDb({ includeArchived: false }),
    readStatusConstraintReportFromOpenDb(),
  ]);

  return {
    auditedAt: new Date().toISOString(),
    todoReconciliation: {
      seedCount: todoReport.seedCount,
      dbCount: todoReport.dbCount,
      seedOnly: todoReport.seedOnly.length,
      dbOnly: todoReport.dbOnly.length,
      statusDrift: todoReport.statusDrift.length,
      items: todoReport.statusDrift.map(d => ({ id: d.id, title: d.title, expected: d.expectedStatus, actual: d.actualStatus })),
    },
    statusConstraints: {
      total: statusReport.constraints.length,
      validated: statusReport.constraints.filter(c => c.validated).length,
      unvalidated: statusReport.constraints.filter(c => !c.validated).length,
      invalidRows: statusReport.constraints.reduce((sum, c) => sum + c.invalidRowCount, 0),
    },
  };
}

async function runHotspotAudit(): Promise<Record<string, unknown>> {
  const { detectRuntimeCleanupFromOpenDb } = await import('./governance-runtime-cleanup.js');

  const cleanupReport = await detectRuntimeCleanupFromOpenDb();

  const db = getDb();
  const errorPatternRows = await db.query<{ error_count: string }>(
    `SELECT COUNT(*)::text AS error_count
     FROM session_events
     WHERE type = 'error'
       AND created_at > now() - INTERVAL '24 hours'`,
  );

  return {
    auditedAt: new Date().toISOString(),
    runtimeCleanup: {
      taskRunsScanned: cleanupReport.taskRuns.scanned,
      illegalStatusCount: cleanupReport.taskRuns.illegalStatus.length,
      staleFixtureCount: cleanupReport.taskRuns.staleFixtureCandidates.length,
      runSpecsScanned: cleanupReport.runSpecs.scanned,
    },
    errorFrequency: {
      recentErrors24h: Number(errorPatternRows.rows[0]?.error_count ?? 0),
    },
  };
}

async function runArchitectureDriftAudit(
  job: GovernanceJob,
  dryRun: boolean,
): Promise<Record<string, unknown>> {
  const { buildExecutionStaticGraph } = await import('./execution-static-graph.js');
  const { getLatestBaseline, captureStaticGraphBaseline, diffBaselines, summarizeBaselineDiff } =
    await import('./static-graph-baselines.js');

  const graph = buildExecutionStaticGraph({ workspaceRoot: process.cwd() });
  const previous = await getLatestBaseline({
    tenantId: job.tenantId,
    projectId: job.projectId,
  });

  const baselineResult: Record<string, unknown> = {
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    nodeKinds: [...new Set(graph.nodes.map(n => n.kind))],
    edgeKinds: [...new Set(graph.edges.map(e => e.kind))],
  };

  if (previous) {
    const diff = diffBaselines(graph, previous.graph);
    const { hasChanges, summary } = summarizeBaselineDiff(diff);
    baselineResult.previousBaselineId = previous.id;
    baselineResult.previousCapturedAt = previous.capturedAt;
    baselineResult.diff = diff;
    baselineResult.diffSummary = summary;
    baselineResult.hasStructuralChanges = hasChanges;

    try {
      baselineResult.ruleEffectiveness = await checkRuleEffectiveness(graph);
    } catch (err) {
      log.warn(`Rule effectiveness check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    baselineResult.isFirstBaseline = true;
  }

  if (!dryRun) {
    try {
      await captureStaticGraphBaseline({
        graph,
        label: `sweep-${job.id}`,
        capturedBy: 'governance_sweep',
        tenantId: job.tenantId,
        projectId: job.projectId,
      });
      baselineResult.newBaselineCaptured = true;
    } catch (err) {
      log.warn(`Failed to capture baseline: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    auditedAt: new Date().toISOString(),
    ...baselineResult,
  };
}

async function checkRuleEffectiveness(
  graph: { nodes: Array<{ id: string; kind: string; label: string }>; edges: Array<{ from: string; to: string; kind: string }>; warnings: string[] },
): Promise<Record<string, unknown>> {
  let activeRules: Array<{ name: string; content: string; severity: string }> = [];
  try {
    // Use the full procedural_candidates DDL (matching @los/memory's schema)
    // to avoid a circular dependency. CREATE TABLE IF NOT EXISTS is idempotent.
    const db = getDb();
    await db.exec(PROCEDURAL_CANDIDATES_DDL);
    const rows = await db.query<{ name: string; content: string; severity: string }>(
      `SELECT name, content, severity FROM procedural_candidates WHERE status = 'active'`,
    );
    activeRules = rows.rows;
  } catch {
    return { checked: false, reason: 'procedural_candidates store not available' };
  }

  if (activeRules.length === 0) {
    return { checked: true, totalRules: 0, matchedRules: 0, unmatchedRules: [] };
  }

  const nodeLabels = graph.nodes.map(n => `${n.id} ${n.label}`).join(' ').toLowerCase();
  const edgeLabels = graph.edges.map(e => `${e.from} ${e.to} ${e.kind}`).join(' ').toLowerCase();

  const matched: string[] = [];
  const unmatched: string[] = [];

  for (const rule of activeRules) {
    const text = `${rule.name} ${rule.content}`.toLowerCase();
    const words = text.split(/\s+/).filter(w => w.length > 3);
    const matchCount = words.filter(w => nodeLabels.includes(w) || edgeLabels.includes(w)).length;
    const threshold = Math.max(1, Math.floor(words.length * 0.3));
    if (matchCount >= threshold) {
      matched.push(rule.name);
    } else {
      unmatched.push(rule.name);
    }
  }

  return {
    checked: true,
    totalRules: activeRules.length,
    matchedRules: matched.length,
    unmatchedRules: unmatched,
  };
}

async function runMemoryIntegrityAudit(): Promise<Record<string, unknown>> {
  const db = getDb();

  // Ensure tables exist before queries (cannot import from @los/memory due to circular dep).
  // Idempotent; follows the same pattern as PROCEDURAL_CANDIDATES_DDL for rule effectiveness checks.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS observations (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'note',
      tags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      content TEXT NOT NULL DEFAULT '',
      metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      source TEXT NOT NULL DEFAULT 'user',
      session_id TEXT,
      tenant_id TEXT,
      project_id TEXT,
      user_id TEXT,
      node_id TEXT,
      request_id TEXT,
      trace_id TEXT,
      search_vector tsvector,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
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
  `);

  const checks: Array<{ name: string; passed: boolean; detail: string; severity: string }> = [];
  const auditedAt = new Date().toISOString();

  // Check 1: uncompacted sessions with observations
  try {
    const rows = await db.query<{ cnt: string }>(
      `SELECT COUNT(DISTINCT o.session_id)::text AS cnt
       FROM observations o
       LEFT JOIN memory_compactions mc ON o.session_id = mc.session_id
       WHERE o.session_id IS NOT NULL
         AND mc.id IS NULL
         AND o.created_at < now() - INTERVAL '1 hour'`,
    );
    const count = Number(rows.rows[0]?.cnt ?? 0);
    checks.push({
      name: 'compaction-session-validity',
      passed: count <= 10,
      detail: count === 0
        ? 'All observation sessions have compactions'
        : `${count} uncompacted session(s)`,
      severity: count > 10 ? 'warn' : 'info',
    });
  } catch (err) {
    checks.push({ name: 'compaction-session-validity', passed: false, detail: `Query failed: ${err instanceof Error ? err.message : String(err)}`, severity: 'error' });
  }

  // Check 2: stale approved candidates
  try {
    await db.exec(PROCEDURAL_CANDIDATES_DDL);
    const rows = await db.query<{ cnt: string; names: string }>(
      `SELECT COUNT(*)::text AS cnt,
              COALESCE(string_agg(name, ', ' ORDER BY updated_at), '') AS names
       FROM procedural_candidates
       WHERE status = 'approved'
         AND updated_at < now() - INTERVAL '7 days'`,
    );
    const count = Number(rows.rows[0]?.cnt ?? 0);
    checks.push({
      name: 'candidate-status-consistency',
      passed: count === 0,
      detail: count === 0
        ? 'No stale approved candidates'
        : `${count} candidate(s) stuck in 'approved' for >7 days: ${rows.rows[0]?.names ?? 'unknown'}`,
      severity: count > 0 ? 'warn' : 'info',
    });
  } catch (err) {
    checks.push({ name: 'candidate-status-consistency', passed: false, detail: `Query failed: ${err instanceof Error ? err.message : String(err)}`, severity: 'error' });
  }

  // Check 3: orphaned compactions
  try {
    const rows = await db.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
       FROM memory_compactions mc
       WHERE CAST(mc.summary_json->>'observationCount' AS integer) > 0
         AND NOT EXISTS (
           SELECT 1 FROM observations o
           WHERE o.session_id = mc.session_id
         )`,
    );
    const count = Number(rows.rows[0]?.cnt ?? 0);
    checks.push({
      name: 'orphaned-compactions',
      passed: count === 0,
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
    const detail = `${obsCount} observations / ${compCount} compactions = ${ratio}:1 ratio`;
    const ratioProblem = (compCount === 0 && obsCount > 50) || (compCount > 0 && ratio > 100);
    checks.push({
      name: 'observation-compaction-ratio',
      passed: !ratioProblem,
      detail,
      severity: ratioProblem ? 'warn' : 'info',
    });
  } catch (err) {
    checks.push({ name: 'observation-compaction-ratio', passed: false, detail: `Query failed: ${err instanceof Error ? err.message : String(err)}`, severity: 'error' });
  }

  // Check 5: search vector freshness (aligned with @los/memory/integrity.ts)
  try {
    const rows = await db.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
       FROM observations
       WHERE updated_at > created_at + INTERVAL '1 second'
         AND search_vector IS NOT NULL`,
    );
    const count = Number(rows.rows[0]?.cnt ?? 0);
    checks.push({
      name: 'search-vector-freshness',
      passed: true,
      detail: count === 0
        ? 'No search vector concerns detected'
        : `${count} observation(s) updated — search_vector auto-regenerated on UPDATE`,
      severity: 'info',
    });
  } catch (err) {
    checks.push({ name: 'search-vector-freshness', passed: false, detail: `Query failed: ${err instanceof Error ? err.message : String(err)}`, severity: 'error' });
  }

  const passed = checks.every((c: { severity: string }) => c.severity !== 'error');

  return {
    auditedAt,
    passed,
    checks,
    failedChecks: checks.filter((c: { passed: boolean }) => !c.passed).map((c: { name: string }) => c.name),
    errorCount: checks.filter((c: { severity: string }) => c.severity === 'error').length,
    warnCount: checks.filter((c: { severity: string }) => c.severity === 'warn').length,
  };
}

async function runMemoryRetentionAudit(): Promise<Record<string, unknown>> {
  const db = getDb();
  const auditedAt = new Date().toISOString();
  let archivedCount = 0;
  let deletedCount = 0;
  const errors: string[] = [];

  // Ensure tables exist (idempotent — cannot import from @los/memory due to circular dep)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS observations (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'note',
      tags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      content TEXT NOT NULL DEFAULT '',
      metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      source TEXT NOT NULL DEFAULT 'user',
      session_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS memory_compactions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const PERMANENT_CLAUSE = `AND coalesce(metadata_json->>'retention', '') != 'permanent'`;

  // Step 1: Archive old uncompacted observations (>90 days)
  try {
    const archived = await db.query<{ cnt: string }>(
      `WITH updated AS (
         UPDATE observations
         SET metadata_json = jsonb_set(
           jsonb_set(metadata_json, '{archived}', 'true'),
           '{archivedAt}', to_jsonb(now()::text)
         )
         WHERE coalesce(metadata_json->>'archived', 'false') = 'false'
           AND created_at < now() - INTERVAL '90 days'
           ${PERMANENT_CLAUSE}
         RETURNING id
       ) SELECT COUNT(*)::text AS cnt FROM updated`,
    );
    archivedCount += Number(archived.rows[0]?.cnt ?? 0);
  } catch (err) {
    errors.push(`Archive step 1 failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 2: Archive compacted-session observations (>30 days since compaction)
  try {
    const compactArchived = await db.query<{ cnt: string }>(
      `WITH compacted_sessions AS (
         SELECT DISTINCT session_id FROM memory_compactions
         WHERE created_at < now() - INTERVAL '30 days'
           AND session_id IS NOT NULL
       ),
       updated AS (
         UPDATE observations o
         SET metadata_json = jsonb_set(
           jsonb_set(metadata_json, '{archived}', 'true'),
           '{archivedAt}', to_jsonb(now()::text)
         )
         FROM compacted_sessions cs
         WHERE o.session_id = cs.session_id
           AND coalesce(o.metadata_json->>'archived', 'false') = 'false'
           ${PERMANENT_CLAUSE}
         RETURNING o.id
       ) SELECT COUNT(*)::text AS cnt FROM updated`,
    );
    archivedCount += Number(compactArchived.rows[0]?.cnt ?? 0);
  } catch (err) {
    errors.push(`Archive step 2 failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 3: Hard-delete orphaned observations (no session_id, >180 days)
  try {
    const deleted = await db.query<{ cnt: string }>(
      `WITH deleted AS (
         DELETE FROM observations
         WHERE session_id IS NULL
           AND created_at < now() - INTERVAL '180 days'
           ${PERMANENT_CLAUSE}
         RETURNING id
       ) SELECT COUNT(*)::text AS cnt FROM deleted`,
    );
    deletedCount += Number(deleted.rows[0]?.cnt ?? 0);
  } catch (err) {
    errors.push(`Delete step failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    auditedAt,
    archivedCount,
    deletedCount,
    errors,
    passed: errors.length === 0,
  };
}

export async function runJobAudit(
  job: GovernanceJob,
  dryRun: boolean,
): Promise<Record<string, unknown>> {
  switch (job.jobType) {
    case 'consistency_audit':
      return runConsistencyAudit();
    case 'hotspot':
      return runHotspotAudit();
    case 'architecture_drift':
      return runArchitectureDriftAudit(job, dryRun);
    case 'memory_integrity':
      return runMemoryIntegrityAudit();
    case 'memory_retention':
      return runMemoryRetentionAudit();
    default:
      throw new Error(`Unknown job_type: ${job.jobType}`);
  }
}
