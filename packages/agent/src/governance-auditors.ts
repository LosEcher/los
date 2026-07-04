import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import { PROCEDURAL_CANDIDATES_DDL } from '@los/infra/procedural-candidates-ddl';
import type { ExecSyncOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
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
    case 'file_size': return runFileSizeAudit(job, dryRun);
    case 'related_project_scan': return runRelatedProjectScanAudit();
    case 'supply_chain_audit': return runSupplyChainAuditWrapper();
    case 'static_analysis': return runStaticAnalysisAuditWrapper();
    case 'performance_audit': return runPerformanceAuditWrapper();
    case 'migration_drift_fix': return runMigrationDriftAuditWrapper();
    case 'event_retention': return runEventRetentionAuditWrapper();
    case 'code_topology_audit': return runCodeTopologyAuditWrapper(job);
    default: throw new Error(`Unknown job_type: ${job.jobType}`);
  }
}

// ... (existing branch_cleanup auditor)

async function runFileSizeAudit(job: GovernanceJob, dryRun: boolean): Promise<Record<string, unknown>> {
  try {
    const { scanFileHotspots } = await import('./hotspot-drift-detector.js');
    const hotspotReport = await scanFileHotspots({ workspaceRoot: process.cwd() });
    // Store both the count (for drift metrics) and the file list (for trend detection).
    // Drift iteration expects filesOver400/filesOver600 to be arrays, not numbers.
    return {
      auditedAt: hotspotReport.scannedAt,
      totalFilesScanned: hotspotReport.totalFilesScanned,
      filesOver600: hotspotReport.filesOver600.map(f => ({ file: f.file, lines: f.lines, package: f.package, delta: f.delta })),
      filesOver400: hotspotReport.filesOver400.map(f => ({ file: f.file, lines: f.lines, package: f.package, delta: f.delta })),
      filesOver600Count: hotspotReport.filesOver600.length,
      filesOver400Count: hotspotReport.filesOver400.length,
      newCrossers: hotspotReport.newCrossers.length,
      new600Crossers: hotspotReport.new600Crossers.length,
      shrank: hotspotReport.shrank.length,
      worseningFiles: hotspotReport.trend.worseningFiles,
      totalOver400Delta: hotspotReport.trend.totalOver400Delta,
      totalOver600Delta: hotspotReport.trend.totalOver600Delta,
      avgDelta: hotspotReport.trend.avgDelta,
      topFiles: hotspotReport.filesOver600.slice(0, 10).map(f => ({
        file: f.file, lines: f.lines, package: f.package, delta: f.delta,
      })),
      topWorsening: hotspotReport.trend.worseningFiles.slice(0, 10),
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
      absorbableProjects: absorbable.map(p => ({
        name: p.project.name,
        workspacePath: p.project.workspacePath,
        realPath: p.project.realPath,
        role: p.project.role,
        capabilities: p.absorbableCapabilities ?? [],
        recommendation: p.recommendation,
        lastCommitDate: p.lastCommitDate,
      })),
    };
  } catch (err) {
    return { auditedAt: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Branch hygiene: exec function type + pure summary builder ────────

/**
 * Options the branch-hygiene audit/fix pass to the injected exec. Deliberately
 * narrow (no `encoding` — the real wrapper forces `utf8`) so the type matches
 * `execSync`'s overloads cleanly and fake execs in tests can ignore it.
 */
export type BranchHygieneExecOptions = {
  timeout?: number;
  stdio?: ExecSyncOptions['stdio'];
};

/**
 * Exec function injected into `computeBranchHygieneSummary` / `applyBranchCleanupFix`
 * so the logic is unit-testable without touching the network or filesystem.
 * Implementations should throw on non-zero exit (matching `execSync`), so callers
 * use try/catch for detection.
 */
export type BranchHygieneExecFn = (cmd: string, opts?: BranchHygieneExecOptions) => string;

/**
 * Forgejo mirror drift classification. Single source of truth consumed by
 * `applyBranchCleanupFix` (fix action) and `checkHasFindings` (circuit-breaker
 * impact). `unreachable`/`disabled`/`none` are NOT findings so a forgejo outage
 * never trips the breaker; `syncable` is auto-fixable; `non_ff` escalates.
 */
export type ForgejoDrift = 'none' | 'syncable' | 'non_ff' | 'unreachable' | 'disabled';

/**
 * Pure branch-hygiene audit. Reads detached-HEAD state, working-tree dirtiness,
 * forgejo mirror drift, and stale origin branch count. Never throws — any git
 * failure degrades to a reportable field (e.g. forgejo unreachable → drift
 * `unreachable`, not an error). Caller injects `exec` (real `execSync` in
 * production, a fake in tests).
 */
export function computeBranchHygieneSummary(exec: BranchHygieneExecFn): Record<string, unknown> {
  const auditedAt = new Date().toISOString();

  // Gate: is this a git worktree at all?
  try {
    exec('git rev-parse --is-inside-work-tree', { timeout: 5000 });
  } catch {
    return { auditedAt, branchable: false, reason: 'Not a git worktree' };
  }

  // Detached HEAD. Skip in jj-managed repos (.jj): jj colocate always has
  // detached git HEAD (normal state), and `git checkout main` would disrupt jj.
  let detached = false;
  if (!existsSync('.jj')) {
    try { exec('git symbolic-ref -q HEAD', { timeout: 5000 }); } catch { detached = true; }
  }

  // Working tree dirty? (gates whether detached-HEAD auto-fix is safe)
  let workingTreeDirty = false;
  try {
    const status = exec('git status --porcelain', { timeout: 5000 });
    workingTreeDirty = status.trim().length > 0;
  } catch {
    workingTreeDirty = false; // assume clean if status itself fails
  }

  // Forgejo sync env switch — default enabled (opt out with '0' / 'false').
  const syncFlag = process.env.LOS_BRANCH_GOVERNANCE_FORGEJO_SYNC ?? '';
  const forgejoSyncEnabled = syncFlag !== '0' && syncFlag.toLowerCase() !== 'false';

  // Stale origin branches (coarse count; fix does precise git-cherry classification).
  let staleOriginBranches = 0;
  try {
    const refs = exec('git for-each-ref --format=%(refname:short) refs/remotes/origin', { timeout: 5000 });
    staleOriginBranches = refs
      .split('\n')
      .map(l => l.trim())
      .filter(b => b && b !== 'origin' && !b.startsWith('origin/HEAD') && b !== 'origin/main')
      .length;
  } catch { /* leave at 0 */ }

  // Forgejo drift — only evaluated when sync enabled. Any failure → unreachable (not a finding).
  let forgejoReachable: boolean | null = null;
  let forgejoBehind: number | null = null;
  let forgejoAhead: number | null = null;
  let forgejoFastForwardable: boolean | null = null;
  let forgejoSyncable: boolean | null = null;
  let forgejoDrift: ForgejoDrift;

  if (!forgejoSyncEnabled) {
    forgejoDrift = 'disabled';
  } else {
    try {
      exec('git fetch forgejo --prune', { timeout: 15000, stdio: 'pipe' });
      // Confirm forgejo/main ref resolved (fetch may succeed but ref may be absent).
      exec('git rev-parse --verify forgejo/main', { timeout: 5000, stdio: 'pipe' });
      forgejoReachable = true;

      // `git rev-list --left-right --count forgejo/main...origin/main` → "behind ahead"
      const counts = exec('git rev-list --left-right --count forgejo/main...origin/main', { timeout: 5000 })
        .trim()
        .split(/\s+/);
      // Defend against a malformed single-column output (degenerate repo state):
      // treat as unreachable rather than silently misclassifying ahead as 0.
      if (counts.length < 2) {
        throw new Error(`unexpected rev-list output: "${counts.join(' ')}"`);
      }
      forgejoBehind = Number.parseInt(counts[0] || '0', 10);
      forgejoAhead = Number.parseInt(counts[1] || '0', 10);

      // ff check: is forgejo/main an ancestor of origin/main? (exit 0 = yes)
      try {
        exec('git merge-base --is-ancestor forgejo/main origin/main', { timeout: 5000, stdio: 'pipe' });
        forgejoFastForwardable = true;
      } catch {
        forgejoFastForwardable = false;
      }

      forgejoSyncable = forgejoFastForwardable === true && (forgejoBehind ?? 0) > 0 && (forgejoAhead ?? 0) === 0;

      if (forgejoBehind === 0 && forgejoAhead === 0) {
        forgejoDrift = 'none';
      } else if (forgejoSyncable) {
        forgejoDrift = 'syncable';
      } else {
        forgejoDrift = 'non_ff'; // diverged (ahead > 0) — needs human rebase/reset
      }
    } catch {
      forgejoReachable = false;
      forgejoDrift = 'unreachable';
    }
  }

  return {
    auditedAt,
    branchable: true,
    detached,
    workingTreeDirty,
    forgejoSyncEnabled,
    forgejoReachable,
    forgejoBehind,
    forgejoAhead,
    forgejoFastForwardable,
    forgejoSyncable,
    forgejoDrift,
    staleOriginBranches,
    remoteBranches: staleOriginBranches,
    staleCandidateCount: staleOriginBranches, // alias kept for CLI backward compat
  };
}

async function runBranchCleanupAudit(): Promise<Record<string, unknown>> {
  // Inject the real execSync so the pure `computeBranchHygieneSummary` stays testable.
  const { execSync } = await import('node:child_process');
  const exec: BranchHygieneExecFn = (cmd, opts) =>
    execSync(cmd, { encoding: 'utf8', ...opts }) as string;
  return computeBranchHygieneSummary(exec);
}

async function runSupplyChainAuditWrapper(): Promise<Record<string, unknown>> {
  try {
    const { runSupplyChainAudit } = await import('./governance-auditors-supply-chain.js');
    return runSupplyChainAudit();
  } catch (err) {
    return { auditedAt: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) };
  }
}

async function runMigrationDriftAuditWrapper(): Promise<Record<string, unknown>> {
  try {
    const { runMigrationDriftAudit } = await import('./governance-auditors-migration.js');
    return runMigrationDriftAudit();
  } catch (err) {
    return { auditedAt: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) };
  }
}

async function runEventRetentionAuditWrapper(): Promise<Record<string, unknown>> {
  try {
    const { runEventRetentionAudit } = await import('./governance-auditors-event-retention.js');
    const result = await runEventRetentionAudit();
    return result as Record<string, unknown>;
  } catch (err) {
    return { auditedAt: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) };
  }
}

async function runCodeTopologyAuditWrapper(job: GovernanceJob): Promise<Record<string, unknown>> {
  try {
    const { runCodeTopologyAudit } = await import('./governance-auditors-code-topology.js');
    return runCodeTopologyAudit(job);
  } catch (err) {
    return { auditedAt: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) };
  }
}

async function runStaticAnalysisAuditWrapper(): Promise<Record<string, unknown>> {
  try {
    const { runStaticAnalysisAudit } = await import('./governance-auditors-static-analysis.js');
    return runStaticAnalysisAudit();
  } catch (err) {
    return { auditedAt: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) };
  }
}

async function runPerformanceAuditWrapper(): Promise<Record<string, unknown>> {
  try {
    const { runPerformanceAudit } = await import('./governance-auditors-performance.js');
    return runPerformanceAudit();
  } catch (err) {
    return { auditedAt: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) };
  }
}
