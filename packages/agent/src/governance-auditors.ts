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
    unmatchedRuleNames: unmatched,
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
    default:
      throw new Error(`Unknown job_type: ${job.jobType}`);
  }
}
