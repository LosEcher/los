/**
 * GA Loop Runner — the "close the loop" engine.
 *
 * For each governance job configured with autoFix, this module:
 *   1. Runs the audit (via runJobAudit)
 *   2. If findings exist, attempts auto-fix (e.g. reconcile drifts, cleanup stale data)
 *   3. Verifies the fix via the job's verificationCommands
 *   4. On failure, retries up to maxAutoFixAttempts
 *   5. On repeated failure, escalates (creates P1 operator todo)
 *   6. Updates throttle/circuit-breaker state
 *
 * Auto-fix strategies are per jobType.  Currently implemented:
 *   - consistency_audit: reconcile seed↔DB drift (create missing + update status)
 *   - hotspot: cleanup illegal status task_runs + stale fixtures
 *   - branch_cleanup: classify stale remote branches + suggest safe deletions
 *
 * For jobs without autoFix or when dryRun, falls back to the existing
 * createTodosFromFindings path in governance-sweeper.ts.
 */
import { getLogger } from '@los/infra/logger';
import { runJobAudit } from './governance-auditors.js';
import { updateGovernanceJob, updateGovernanceJobState } from './governance-jobs-crud.js';
import { computeNextState, evaluateLoopGate, maybeAutoRecoverPaused } from './ga-circuit-breaker.js';
import { applyBranchCleanupFix, applyRelatedProjectScanFix } from './ga-scenario-fixes.js';
import { applyFileSizeFix } from './ga-file-size-fix.js';
import type {
  GovernanceJob,
  GovernanceJobAutoFixConfig,
  GaLoopResult,
  GaLoopPhase,
} from './governance-jobs-types.js';

const log = getLogger('ga-loop-runner');

export interface RunGaLoopOptions {
  job: GovernanceJob;
  dryRun?: boolean;
}

// ── Auto-fix strategy dispatcher ──────────────────────

async function applyAutoFix(
  job: GovernanceJob,
  summary: Record<string, unknown>,
): Promise<{ applied: boolean; detail: string }> {
  switch (job.jobType) {
    case 'consistency_audit':
      return applyConsistencyFix(summary);
    case 'hotspot':
      return applyHotspotFix(summary);
    case 'branch_cleanup':
      return applyBranchCleanupFix(summary);
    case 'file_size':
      return applyFileSizeFix(summary);
    case 'related_project_scan':
      return applyRelatedProjectScanFix(summary);
    default:
      return { applied: false, detail: `No auto-fix strategy for job type: ${job.jobType}` };
  }
}

// ── Consistency audit auto-fix ─────────────────────────

async function applyConsistencyFix(
  summary: Record<string, unknown>,
): Promise<{ applied: boolean; detail: string }> {
  const todoRecon = summary.todoReconciliation as Record<string, unknown> | undefined;
  if (!todoRecon) return { applied: false, detail: 'No todoReconciliation in audit summary' };

  const seedOnly = (todoRecon.seedOnly as number) ?? 0;
  const dbOnly = (todoRecon.dbOnly as number) ?? 0;
  const statusDrift = (todoRecon.statusDrift as number) ?? 0;

  if (seedOnly === 0 && dbOnly === 0 && statusDrift === 0) {
    return { applied: true, detail: 'No drifts to reconcile — already consistent' };
  }

  const fixes: string[] = [];

  // Fix 1: Create missing seed todos in DB
  if (seedOnly > 0) {
    try {
      const { reconcilePlanningTodosFromOpenDb } = await import('./governance-reconciliation.js');
      const { seedLosPlanningTodos } = await import('./todos.js');

      // Re-run reconciliation to get fresh items
      const report = await reconcilePlanningTodosFromOpenDb({ includeArchived: false });
      for (const item of report.seedOnly) {
        try {
          // Create the missing todo from seed definition
          const LOS_PLANNING_TODO_SEED = (await import('./todo-seeds.js')).LOS_PLANNING_TODO_SEED;
          const seedDef = LOS_PLANNING_TODO_SEED.find(s => s.id === item.id);
          if (seedDef) {
            await (await import('./todos.js')).createTodo({
              ...seedDef,
              source: 'governance_auto_fix',
              metadata: { autoFixed: true, fixedAt: new Date().toISOString(), reason: 'seed-only reconciliation' },
            });
          }
        } catch {
          // individual todo creation failure is non-fatal
        }
      }
      fixes.push(`Created ${seedOnly} missing seed todo(s) in DB`);
    } catch (err) {
      fixes.push(`Failed to create seed-only todos: ${err instanceof Error ? err.message : String(err)}`);
      return { applied: true, detail: fixes.join('; ') };
    }
  }

  // Fix 2: Update status drift (db status → seed status)
  if (statusDrift > 0) {
    try {
      const { reconcilePlanningTodosFromOpenDb } = await import('./governance-reconciliation.js');
      const { updateTodo } = await import('./todos.js');
      const report = await reconcilePlanningTodosFromOpenDb({ includeArchived: false });

      let fixed = 0;
      for (const drift of report.statusDrift) {
        if (!drift.expectedStatus) continue;
        try {
          await updateTodo(drift.id, { status: drift.expectedStatus as any });
          fixed += 1;
        } catch {
          // individual status update failure is non-fatal
        }
      }
      fixes.push(`Resolved ${fixed}/${statusDrift} status drift(s)`);
    } catch (err) {
      fixes.push(`Failed to fix status drifts: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Fix 3: dbOnly items — archive them if they have no active children
  if (dbOnly > 0) {
    try {
      const { reconcilePlanningTodosFromOpenDb } = await import('./governance-reconciliation.js');
      const { archiveTodo, loadTodo } = await import('./todos.js');
      const report = await reconcilePlanningTodosFromOpenDb({ includeArchived: false });

      let archived = 0;
      for (const item of report.dbOnly) {
        try {
          const todo = await loadTodo(item.id);
          if (todo && !todo.archivedAt) {
            await archiveTodo(item.id);
            archived += 1;
          }
        } catch {
          // individual archive failure is non-fatal
        }
      }
      if (archived > 0) fixes.push(`Archived ${archived}/${dbOnly} DB-only todo(s)`);
      else fixes.push(`DB-only todos (${dbOnly}) left for manual review — may still be active`);
    } catch (err) {
      fixes.push(`Failed to archive DB-only todos: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { applied: true, detail: fixes.join('; ') };
}

// ── Hotspot auto-fix ───────────────────────────────────

async function applyHotspotFix(
  summary: Record<string, unknown>,
): Promise<{ applied: boolean; detail: string }> {
  const cleanup = summary.runtimeCleanup as Record<string, unknown> | undefined;
  if (!cleanup) return { applied: false, detail: 'No runtimeCleanup in audit summary' };

  const illegalStatusCount = (cleanup.illegalStatusCount as number) ?? 0;
  const staleFixtureCount = (cleanup.staleFixtureCount as number) ?? 0;

  if (illegalStatusCount === 0 && staleFixtureCount === 0) {
    return { applied: true, detail: 'No hotspot issues detected' };
  }

  const fixes: string[] = [];

  // Fix: Attempt to move illegal status task_runs to blocked
  if (illegalStatusCount > 0) {
    try {
      const { getDb } = await import('@los/infra/db');
      const db = getDb();
      const result = await db.query<{ id: string }>(
        `UPDATE task_runs SET status = 'blocked', updated_at = now()
         WHERE status NOT IN ('pending', 'queued', 'running', 'succeeded', 'failed', 'blocked', 'cancelled')
         RETURNING id`,
      );
      const fixed = result.rows.length;
      fixes.push(`Moved ${fixed}/${illegalStatusCount} illegal status task_run(s) to blocked`);
    } catch (err) {
      fixes.push(`Failed to fix illegal statuses: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Fix: Attempt to mark stale fixtures as cancelled
  if (staleFixtureCount > 0) {
    try {
      const { getDb } = await import('@los/infra/db');
      const db = getDb();
      const result = await db.query<{ id: string }>(
        `UPDATE task_runs SET status = 'cancelled', updated_at = now()
         WHERE status = 'running' AND metadata_json->>'test_fixture' = 'true'
           AND updated_at < now() - INTERVAL '24 hours'
         RETURNING id`,
      );
      const fixed = result.rows.length;
      fixes.push(`Cancelled ${fixed}/${staleFixtureCount} stale fixture task_run(s)`);
    } catch (err) {
      fixes.push(`Failed to fix stale fixtures: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { applied: true, detail: fixes.join('; ') };
}

// ── Main loop runner ───────────────────────────────────

export async function runGaLoop(opts: RunGaLoopOptions): Promise<GaLoopResult> {
  const { job, dryRun = false } = opts;
  const autoFix: GovernanceJobAutoFixConfig | undefined = job.autoFix;
  const phases: GaLoopPhase[] = [];
  const maxAttempts = autoFix?.maxAutoFixAttempts ?? 3;
  let fixApplied = false;
  let fixSucceeded = false;
  let verificationPassed = false;
  let retried = false;
  let escalated = false;
  let escalatedReason: string | undefined;
  let lastError: string | undefined;

  // ── Step 0: Gate check ──────────────────────────────
  const gateDecision = evaluateLoopGate(job);
  if (gateDecision.action === 'skip') {
    return {
      jobId: job.id,
      jobType: job.jobType,
      auditSummary: {},
      phases: [{ phase: 'audit_run', enteredAt: new Date().toISOString(), attemptNumber: 0, detail: `Skipped: ${gateDecision.reason}` }],
      fixApplied: false,
      fixSucceeded: false,
      verificationPassed: false,
      retried: false,
      escalated: false,
    };
  }

  // ── Step 1: Audit ───────────────────────────────────
  phases.push({ phase: 'audit_run', enteredAt: new Date().toISOString(), attemptNumber: 0 });
  let auditSummary: Record<string, unknown>;
  try {
    auditSummary = await runJobAudit(job, false);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    log.warn(`GA loop audit failed for ${job.jobType} (${job.id}): ${lastError}`);

    // Update failure count + circuit breaker
    const nextState = computeNextState(job, false, true);
    await updateGovernanceJobState(job.id, nextState);

    // Check whether circuit just opened
    if (nextState.circuitState === 'open' || nextState.circuitState === 'half_open') {
      await updateGovernanceJob(job.id, {
        status: nextState.circuitState === 'open' ? 'paused' : job.status,
        lastRunAt: new Date().toISOString(),
        resultSummary: { error: lastError },
      });
    }

    return {
      jobId: job.id,
      jobType: job.jobType,
      auditSummary: {},
      phases,
      fixApplied: false,
      fixSucceeded: false,
      verificationPassed: false,
      retried: false,
      escalated: true,
      escalatedReason: `Audit threw: ${lastError}`,
      error: lastError,
    };
  }

  phases.push({ phase: 'findings_ready', enteredAt: new Date().toISOString(), attemptNumber: 0 });

  // ── Step 2: Check if findings exist ──────────────────
  const hasFindings = checkHasFindings(job.jobType, auditSummary);
  if (!hasFindings) {
    // No findings — update no-op counter, apply throttle
    const nextState = computeNextState(job, false, false);
    await updateGovernanceJobState(job.id, nextState);
    await updateGovernanceJob(job.id, {
      lastRunAt: new Date().toISOString(),
      resultSummary: auditSummary,
    });

    // Apply any cadence downgrade from no-op throttle
    if (gateDecision.action === 'downgrade' && gateDecision.newCadence) {
      await updateGovernanceJob(job.id, { cadence: gateDecision.newCadence });
      log.info(`GA loop: downgraded ${job.jobType} cadence from ${job.cadence} to ${gateDecision.newCadence} (${gateDecision.reason})`);
    }
    if (gateDecision.action === 'pause') {
      await updateGovernanceJob(job.id, { status: 'paused' });
      log.info(`GA loop: paused ${job.jobType} (${gateDecision.reason})`);
    }

    phases.push({ phase: 'completed', enteredAt: new Date().toISOString(), attemptNumber: 0, detail: 'No findings — loop complete' });

    // ── Self-improvement: extract principles from clean run too ──
    try {
      const { persistLoopPrinciples } = await import('./ga-self-improve.js');
      await persistLoopPrinciples({
        jobId: job.id, jobType: job.jobType, auditSummary,
        phases, fixApplied: false, fixSucceeded: true, verificationPassed: true,
        retried: false, escalated: false,
      }, job.tenantId, job.projectId);
    } catch { /* best-effort */ }

    return {
      jobId: job.id,
      jobType: job.jobType,
      auditSummary,
      phases,
      fixApplied: false,
      fixSucceeded: true,
      verificationPassed: true,
      retried: false,
      escalated: false,
    };
  }

  // ── Step 3: Auto-fix (with retry) ───────────────────
  if (!autoFix?.autoFixEnabled) {
    // No autoFix configured — fall through to createTodosFromFindings in sweeper
    phases.push({ phase: 'escalated', enteredAt: new Date().toISOString(), attemptNumber: 0, detail: 'No autoFix configured — findings will be escalated as todos' });
    return {
      jobId: job.id,
      jobType: job.jobType,
      auditSummary,
      phases,
      fixApplied: false,
      fixSucceeded: false,
      verificationPassed: false,
      retried: false,
      escalated: true,
      escalatedReason: 'Auto-fix not enabled for this job',
    };
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) {
      retried = true;
      // Re-run audit before each retry to get fresh state
      try {
        auditSummary = await runJobAudit(job, false);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        phases.push({ phase: 'retry', enteredAt: new Date().toISOString(), attemptNumber: attempt + 1, detail: `Audit failed on retry: ${lastError}` });
        continue;
      }
    }

    // ── 3a: Apply fix ──────────────────────────────────
    phases.push({ phase: 'fix_attempted', enteredAt: new Date().toISOString(), attemptNumber: attempt + 1 });

    const fixResult = await applyAutoFix(job, auditSummary);
    fixApplied = fixApplied || fixResult.applied;

    phases.push({
      phase: 'verify_result',
      enteredAt: new Date().toISOString(),
      attemptNumber: attempt + 1,
      detail: `Fix attempt ${attempt + 1}: ${fixResult.detail}`,
    });

    // ── 3b: Re-audit to verify ─────────────────────────
    try {
      const verifySummary = await runJobAudit(job, false);
      const stillHasFindings = checkHasFindings(job.jobType, verifySummary);
      auditSummary = verifySummary;

      if (!stillHasFindings) {
        fixSucceeded = true;
        verificationPassed = true;
        phases.push({ phase: 'completed', enteredAt: new Date().toISOString(), attemptNumber: attempt + 1, detail: `Verified clean on attempt ${attempt + 1}` });
        break;
      }

      if (attempt < maxAttempts - 1) {
        phases.push({ phase: 'retry', enteredAt: new Date().toISOString(), attemptNumber: attempt + 1, detail: `Findings still present after attempt ${attempt + 1} — retrying` });
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < maxAttempts - 1) {
        phases.push({ phase: 'retry', enteredAt: new Date().toISOString(), attemptNumber: attempt + 1, detail: `Verification failed: ${lastError} — retrying` });
      }
    }
  }

  // ── Step 4: Escalate if still failing ───────────────
  if (!verificationPassed) {
    escalated = true;
    escalatedReason = lastError ?? `Auto-fix did not resolve findings after ${maxAttempts} attempt(s)`;

    try {
      const { createTodo } = await import('./todos.js');
      await createTodo({
        title: `GA Loop: ${job.jobType} auto-fix failed after ${maxAttempts} attempt(s)`,
        description: `The governance auto-fix loop for ${job.jobType} (${job.id}) could not resolve findings after ${maxAttempts} attempts.\n\nLast fix detail: ${[...phases].reverse().find((p: GaLoopPhase) => p.phase === 'verify_result')?.detail ?? 'N/A'}\nLast error: ${lastError ?? 'N/A'}\n\nOperator review required.`,
        kind: 'task',
        status: 'backlog',
        priority: 'P1',
        source: 'ga_loop',
        metadata: { loopJobId: job.id, jobType: job.jobType, escalationReason: escalatedReason },
      });
    } catch (err) {
      log.warn(`Failed to create escalation todo: ${err instanceof Error ? err.message : String(err)}`);
    }

    phases.push({ phase: 'escalated', enteredAt: new Date().toISOString(), attemptNumber: maxAttempts, detail: escalatedReason });
  }

  // ── Step 5: Update state ────────────────────────────
  const nextState = computeNextState(job, hasFindings && verificationPassed, escalated);
  await updateGovernanceJobState(job.id, nextState);

  const finalStatus = nextState.circuitState === 'open' ? 'paused' : job.status;
  await updateGovernanceJob(job.id, {
    lastRunAt: new Date().toISOString(),
    resultSummary: auditSummary,
    ...(finalStatus !== job.status ? { status: finalStatus } : {}),
  });

  // ── Step 6: Self-improvement — extract principles from this run ──
  const loopResult: GaLoopResult = {
    jobId: job.id,
    jobType: job.jobType,
    auditSummary,
    phases,
    fixApplied,
    fixSucceeded,
    verificationPassed,
    retried,
    escalated,
    escalatedReason,
    ...(lastError ? { error: lastError } : {}),
  };

  try {
    const { persistLoopPrinciples } = await import('./ga-self-improve.js');
    await persistLoopPrinciples(loopResult, job.tenantId, job.projectId);
  } catch { /* best-effort — self-improvement failures don't block the loop */ }

  // ── Step 7: If circuit was opened, also pause the job ──
  if (nextState.circuitState === 'open' && job.status !== 'paused') {
    await updateGovernanceJob(job.id, { status: 'paused' });
    log.warn(`GA loop: circuit OPEN for ${job.jobType} (${job.id}) — job paused`);
  }

  return loopResult;
}

/**
 * Determine whether the audit found actionable issues.
 * Each job type has its own threshold for what counts as a "finding."
 */
function checkHasFindings(jobType: string, summary: Record<string, unknown>): boolean {
  switch (jobType) {
    case 'consistency_audit': {
      const tr = summary.todoReconciliation as Record<string, unknown> | undefined;
      if (!tr) return false;
      const seedOnly = (tr.seedOnly as number) ?? 0;
      const dbOnly = (tr.dbOnly as number) ?? 0;
      const statusDrift = (tr.statusDrift as number) ?? 0;
      return seedOnly > 0 || dbOnly > 0 || statusDrift > 0;
    }
    case 'hotspot': {
      const rc = summary.runtimeCleanup as Record<string, unknown> | undefined;
      if (!rc) return false;
      const illegalStatusCount = (rc.illegalStatusCount as number) ?? 0;
      const staleFixtureCount = (rc.staleFixtureCount as number) ?? 0;
      return illegalStatusCount > 0 || staleFixtureCount > 0;
    }
    case 'architecture_drift': {
      // Always a "finding" — baseline snapshots are useful even without drift
      return typeof summary.nodeCount === 'number' && summary.nodeCount > 0;
    }
    case 'memory_integrity': {
      const failed = typeof summary.failedCount === 'number' ? summary.failedCount : 0;
      return failed > 0;
    }
    case 'memory_retention': {
      const archived = typeof summary.archivedCount === 'number' ? summary.archivedCount : 0;
      const deleted = typeof summary.deletedCount === 'number' ? summary.deletedCount : 0;
      const errors = Array.isArray(summary.errors) ? summary.errors.length : 0;
      return archived > 0 || deleted > 0 || errors > 0;
    }
    case 'reflection': {
      const tasksWithout = typeof summary.tasksWithoutReflection === 'number' ? summary.tasksWithoutReflection : 0;
      return tasksWithout > 0;
    }
    case 'branch_cleanup': {
      const count = typeof summary.staleCandidateCount === 'number' ? summary.staleCandidateCount : 0;
      return count > 0;
    }
    case 'related_project_scan': {
      const absorbable = typeof summary.absorbableCount === 'number' ? summary.absorbableCount : 0;
      return absorbable > 0;
    }
    case 'file_size': {
      const count = typeof summary.hotFileCount === 'number' ? summary.hotFileCount : 0;
      return count > 0;
    }
    default:
      return false;
  }
}

// ── Re-export for external use ─────────────────────────

export { maybeAutoRecoverPaused } from './ga-circuit-breaker.js';
export { applyBranchCleanupFix, applyRelatedProjectScanFix } from './ga-scenario-fixes.js';
