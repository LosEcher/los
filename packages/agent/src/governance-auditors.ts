import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import { PROCEDURAL_CANDIDATES_DDL } from '@los/infra/procedural-candidates-ddl';
import type { GovernanceJob } from './governance-jobs-types.js';
import { runMemoryIntegrityAudit, runMemoryRetentionAudit } from './governance-auditors-memory.js';

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
      seedCount: todoReport.seedCount, dbCount: todoReport.dbCount,
      seedOnly: todoReport.seedOnly.length, dbOnly: todoReport.dbOnly.length,
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
    `SELECT COUNT(*)::text AS error_count FROM session_events WHERE type = 'error' AND created_at > now() - INTERVAL '24 hours'`,
  );
  return {
    auditedAt: new Date().toISOString(),
    runtimeCleanup: {
      taskRunsScanned: cleanupReport.taskRuns.scanned,
      illegalStatusCount: cleanupReport.taskRuns.illegalStatus.length,
      staleFixtureCount: cleanupReport.taskRuns.staleFixtureCandidates.length,
      runSpecsScanned: cleanupReport.runSpecs.scanned,
    },
    errorFrequency: { recentErrors24h: Number(errorPatternRows.rows[0]?.error_count ?? 0) },
  };
}

async function runArchitectureDriftAudit(job: GovernanceJob, dryRun: boolean): Promise<Record<string, unknown>> {
  const { buildExecutionStaticGraph } = await import('./execution-static-graph.js');
  const { getLatestBaseline, captureStaticGraphBaseline, diffBaselines, summarizeBaselineDiff } = await import('./static-graph-baselines.js');
  const graph = buildExecutionStaticGraph({ workspaceRoot: process.cwd() });
  const previous = await getLatestBaseline({ tenantId: job.tenantId, projectId: job.projectId });
  const baselineResult: Record<string, unknown> = {
    nodeCount: graph.nodes.length, edgeCount: graph.edges.length,
    nodeKinds: [...new Set(graph.nodes.map(n => n.kind))],
    edgeKinds: [...new Set(graph.edges.map(e => e.kind))],
  };
  if (previous) {
    const diff = diffBaselines(graph, previous.graph);
    const { hasChanges, summary } = summarizeBaselineDiff(diff);
    baselineResult.previousBaselineId = previous.id;
    baselineResult.previousCapturedAt = previous.capturedAt;
    baselineResult.diff = diff; baselineResult.diffSummary = summary;
    baselineResult.hasStructuralChanges = hasChanges;
    try { baselineResult.ruleEffectiveness = await checkRuleEffectiveness(graph); }
    catch (err) { log.warn(`Rule effectiveness check failed: ${err instanceof Error ? err.message : String(err)}`); }
  } else { baselineResult.isFirstBaseline = true; }
  if (!dryRun) {
    try {
      await captureStaticGraphBaseline({ graph, label: `sweep-${job.id}`, capturedBy: 'governance_sweep', tenantId: job.tenantId, projectId: job.projectId });
      baselineResult.newBaselineCaptured = true;
    } catch (err) { log.warn(`Failed to capture baseline: ${err instanceof Error ? err.message : String(err)}`); }
  }
  return { auditedAt: new Date().toISOString(), ...baselineResult };
}

async function checkRuleEffectiveness(
  graph: { nodes: Array<{ id: string; kind: string; label: string }>; edges: Array<{ from: string; to: string; kind: string }>; warnings: string[] },
): Promise<Record<string, unknown>> {
  let activeRules: Array<{ name: string; content: string; severity: string }> = [];
  try {
    const db = getDb();
    await db.exec(PROCEDURAL_CANDIDATES_DDL);
    const rows = await db.query<{ name: string; content: string; severity: string }>(
      `SELECT name, content, severity FROM procedural_candidates WHERE status = 'active'`,
    );
    activeRules = rows.rows;
  } catch { return { checked: false, reason: 'procedural_candidates store not available' }; }
  if (activeRules.length === 0) return { checked: true, totalRules: 0, matchedRules: 0, unmatchedRules: [] };
  const nodeLabels = graph.nodes.map(n => `${n.id} ${n.label}`).join(' ').toLowerCase();
  const edgeLabels = graph.edges.map(e => `${e.from} ${e.to} ${e.kind}`).join(' ').toLowerCase();
  const matched: string[] = [], unmatched: string[] = [];
  for (const rule of activeRules) {
    const text = `${rule.name} ${rule.content}`.toLowerCase();
    const words = text.split(/\s+/).filter(w => w.length > 3);
    const matchCount = words.filter(w => nodeLabels.includes(w) || edgeLabels.includes(w)).length;
    const threshold = Math.max(1, Math.floor(words.length * 0.3));
    (matchCount >= threshold ? matched : unmatched).push(rule.name);
  }
  return { checked: true, totalRules: activeRules.length, matchedRules: matched.length, unmatchedRules: unmatched };
}

async function runReflectionAudit(): Promise<Record<string, unknown>> {
  const db = getDb();
  const auditedAt = new Date().toISOString();
  const blockedRows = await db.query<{ cnt: string; recovery_types: string }>(
    `SELECT COUNT(*)::text AS cnt, COALESCE(string_agg(DISTINCT metadata_json->'reflection'->>'recoveryType', ', '), '') AS recovery_types
     FROM task_runs WHERE status IN ('blocked', 'failed') AND updated_at > now() - INTERVAL '24 hours' AND metadata_json->'reflection' IS NOT NULL`,
  );
  const withReflection = Number(blockedRows.rows[0]?.cnt ?? 0);
  const recoveryTypes = String(blockedRows.rows[0]?.recovery_types ?? '');
  const withoutRows = await db.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM task_runs WHERE status IN ('blocked', 'failed') AND updated_at > now() - INTERVAL '24 hours' AND (metadata_json->'reflection' IS NULL)`,
  );
  const withoutReflection = Number(withoutRows.rows[0]?.cnt ?? 0);
  const todoRows = await db.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM todos WHERE source = 'reflection' AND created_at > now() - INTERVAL '24 hours'`,
  );
  const recoveryTodos = Number(todoRows.rows[0]?.cnt ?? 0);
  return {
    auditedAt, tasksWithReflection: withReflection, tasksWithoutReflection: withoutReflection,
    recoveryTypes, recoveryTodosCreated: recoveryTodos,
    coverage: withReflection + withoutReflection > 0 ? `${Math.round((withReflection / (withReflection + withoutReflection)) * 100)}%` : 'N/A',
  };
}

export async function runJobAudit(job: GovernanceJob, dryRun: boolean): Promise<Record<string, unknown>> {
  switch (job.jobType) {
    case 'consistency_audit': return runConsistencyAudit();
    case 'hotspot': return runHotspotAudit();
    case 'architecture_drift': return runArchitectureDriftAudit(job, dryRun);
    case 'memory_integrity': return runMemoryIntegrityAudit();
    case 'memory_retention': return runMemoryRetentionAudit();
    case 'reflection': return runReflectionAudit();
    case 'branch_cleanup': return runBranchCleanupAudit();
    case 'file_size': return runFileSizeAudit();
    case 'related_project_scan': return runRelatedProjectScanAudit();
    default: throw new Error(`Unknown job_type: ${job.jobType}`);
  }
}

// ... (existing branch_cleanup auditor)

async function runFileSizeAudit(): Promise<Record<string, unknown>> {
  try {
    const { detectHotFiles } = await import('./ga-file-size-fix.js');
    const hotFiles = detectHotFiles(process.cwd());
    const newFiles = hotFiles.filter(f => f.isNew);
    const blockFiles = hotFiles.filter(f => f.threshold === 'block');
    return {
      auditedAt: new Date().toISOString(),
      hotFileCount: hotFiles.length,
      blockFiles: blockFiles.length,
      newOverThreshold: newFiles.length,
      totalLinesInHotFiles: hotFiles.reduce((sum, f) => sum + f.lines, 0),
      files: hotFiles.slice(0, 20).map(f => ({ path: f.path, lines: f.lines, threshold: f.threshold, isNew: f.isNew })),
    };
  } catch (err) {
    return { auditedAt: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) };
  }
}

// ... (before runBranchCleanupAudit)

async function runRelatedProjectScanAudit(): Promise<Record<string, unknown>> {
  try {
    const { scanRelatedProjects } = await import('./ga-related-project-scanner.js');
    const result = await scanRelatedProjects(process.cwd());
    const absorbable = result.projects.filter(p => p.absorbableCapabilities && p.absorbableCapabilities.length > 0);
    const inaccessible = result.projects.filter(p => !p.accessible);
    return {
      auditedAt: result.scannedAt,
      since: result.since,
      totalProjects: result.projects.length,
      accessibleProjects: result.projects.filter(p => p.accessible).length,
      withNewFeatures: result.projects.filter(p => p.newFeatures && p.newFeatures.length > 0).length,
      absorbableCount: absorbable.length,
      inaccessibleCount: inaccessible.length,
    };
  } catch (err) {
    return { auditedAt: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) };
  }
}

async function runBranchCleanupAudit(): Promise<Record<string, unknown>> {
  // Branch cleanup audit is a lightweight pre-check: does the repo
  // have any stale remote branches? The actual fix runs in applyBranchCleanupFix.
  try {
    const { execSync } = await import('node:child_process');
    execSync('git rev-parse --is-inside-work-tree', { encoding: 'utf8', timeout: 5000 });
  } catch {
    return { auditedAt: new Date().toISOString(), branchable: false, reason: 'Not a git worktree' };
  }

  let branchCount = 0;
  try {
    const refsOutput = (await import('node:child_process')).execSync(
      'git for-each-ref --format=%(refname:short) refs/remotes/origin',
      { encoding: 'utf8', timeout: 5000 },
    );
    branchCount = refsOutput
      .split('\n')
      .map(l => l.trim())
      .filter(b => b && b !== 'origin' && !b.startsWith('origin/HEAD') && b !== 'origin/main')
      .length;
  } catch {
    return { auditedAt: new Date().toISOString(), branchable: true, remoteBranches: 0, staleCandidateCount: 0 };
  }

  return {
    auditedAt: new Date().toISOString(),
    branchable: true,
    remoteBranches: branchCount,
    staleCandidateCount: branchCount, // all non-main remote branches are candidates
  };
}
