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
import { applyConsistencyFix, applyHotspotFix } from './ga-loop-fixes.js';
import { appendSessionEvent } from './session-events.js';
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
  /** Governance sweep session ID for event emission. When provided, fix/escalation events are emitted. */
  sessionId?: string;
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
      // detection-only now (TODO-worklist); autoFix disabled in seed.
      return { applied: false, detail: 'detection-only job — autoFix disabled; TODOs surface for a Claude agent to extract submodules via /pr-self-merge' };
    case 'related_project_scan':
      return applyRelatedProjectScanFix(summary);
    case 'migration_drift_fix':
      // Detection-only job — autoFix disabled by seed config. No-op for clarity.
      return { applied: false, detail: 'detection-only job — autoFix disabled; TODOs surface for a Claude agent to work via /pr-self-merge' };
    default:
      return { applied: false, detail: `No auto-fix strategy for job type: ${job.jobType}` };
  }
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
  // hadError = a real throw (audit/verify error). Distinct from `escalated`
  // (auto-fix couldn't resolve findings after maxAttempts — needs human, NOT a
  // failure). Only hadError trips the circuit breaker; escalation must stay
  // visible (it surfaces an operator TODO each sweep until resolved).
  let hadError = false;

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
    } catch (err) { log.warn(`Session event emission failed: ${err instanceof Error ? err.message : String(err)}`); }

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

        // Best-effort fix_applied event — must not abort the sweep
        if (opts.sessionId) {
          try {
            await appendSessionEvent({
              sessionId: opts.sessionId,
              type: 'governance.job.fix_applied',
              source: 'governance',
              tenantId: job.tenantId ?? undefined,
              projectId: job.projectId ?? undefined,
              payload: {
                jobId: job.id, jobType: job.jobType,
                fixApplied, fixSucceeded: true, verificationPassed: true,
                attemptNumber: attempt + 1,
              },
            });
          } catch (err) { log.warn(`Session event emission failed: ${err instanceof Error ? err.message : String(err)}`); }
        }

        break;
      }

      if (attempt < maxAttempts - 1) {
        phases.push({ phase: 'retry', enteredAt: new Date().toISOString(), attemptNumber: attempt + 1, detail: `Findings still present after attempt ${attempt + 1} — retrying` });
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      hadError = true; // verify threw — real error, counts toward circuit breaker
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
      // Dedupe per job: escalation no longer trips the breaker (it needs human,
      // not retry), so the job runs every sweep and escalates — without dedupe
      // this would spam a new TODO each sweep. Reuse one TODO per job, reopen
      // if archived, refresh detail each sweep.
      const { createTodo, listTodos, updateTodo, unarchiveTodo } = await import('./todos.js');
      const dedupeKey = `ga-loop-escalation-${job.jobType}`;
      const title = `GA Loop: ${job.jobType} auto-fix could not resolve findings — operator review required`;
      const description = `The governance auto-fix loop for ${job.jobType} (${job.id}) could not resolve findings after ${maxAttempts} attempt(s).\n\nLast fix detail: ${[...phases].reverse().find((p: GaLoopPhase) => p.phase === 'verify_result')?.detail ?? 'N/A'}\nLast error: ${lastError ?? 'N/A'}\n\nOperator review required. (This TODO is refreshed each sweep until the finding is resolved; the job is NOT paused because escalation is a needs-human signal, not a failure.)`;
      const metadata = { loopJobId: job.id, jobType: job.jobType, escalationReason: escalatedReason };
      const existing = await listTodos({ source: 'ga_loop', limit: 500, includeArchived: true });
      const ex = existing.find((t) => t.dedupeKey === dedupeKey);
      if (ex) {
        if (ex.archivedAt) await unarchiveTodo(ex.id);
        await updateTodo(ex.id, { title, description, status: 'ready', priority: 'P1', metadata });
      } else {
        await createTodo({ title, description, kind: 'task', status: 'ready', priority: 'P1', source: 'ga_loop', dedupeKey, metadata });
      }
    } catch (err) {
      log.warn(`Failed to create escalation todo: ${err instanceof Error ? err.message : String(err)}`);
    }

    phases.push({ phase: 'escalated', enteredAt: new Date().toISOString(), attemptNumber: maxAttempts, detail: escalatedReason });

    // Best-effort escalation event — must not abort the sweep
    if (opts.sessionId) {
      try {
        await appendSessionEvent({
          sessionId: opts.sessionId,
          type: 'governance.job.escalated',
          source: 'governance',
          tenantId: job.tenantId ?? undefined,
          projectId: job.projectId ?? undefined,
          payload: {
            jobId: job.id, jobType: job.jobType,
            escalatedReason, maxAttempts,
            fixApplied, fixSucceeded, verificationPassed,
          },
        });
      } catch (err) { log.warn(`Session event emission failed: ${err instanceof Error ? err.message : String(err)}`); }
    }
  }

  // ── Step 5: Update state ────────────────────────────
  // hadFindings = hasFindings (findings existed → not a no-op, even if unresolved
  // and escalated). hadError = real throw only (escalation is NOT a failure — it
  // needs human, and must stay visible rather than trip the breaker for 24h).
  const nextState = computeNextState(job, hasFindings, hadError);
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
export function checkHasFindings(jobType: string, summary: Record<string, unknown>): boolean {
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
      const detached = summary.detached === true;
      // Read staleOriginBranches, falling back to the legacy staleCandidateCount
      // alias so older persisted summaries (written before this change) still count.
      const staleRaw = summary.staleOriginBranches ?? summary.staleCandidateCount;
      const stale = typeof staleRaw === 'number' ? staleRaw : 0;
      const drift = typeof summary.forgejoDrift === 'string' ? summary.forgejoDrift : 'none';
      // 'unreachable' and 'disabled' are NOT findings — a forgejo outage or opt-out
      // must not trip the circuit breaker. 'syncable' is auto-fixable; 'non_ff' escalates.
      const driftFinding = drift === 'syncable' || drift === 'non_ff';
      return detached || stale > 0 || driftFinding;
    }
    case 'related_project_scan': {
      const absorbable = typeof summary.absorbableCount === 'number' ? summary.absorbableCount : 0;
      return absorbable > 0;
    }
    case 'file_size': {
      // Audit returns filesOver400Count/filesOver600Count (NOT hotFileCount).
      const c400 = typeof summary.filesOver400Count === 'number' ? summary.filesOver400Count : 0;
      const c600 = typeof summary.filesOver600Count === 'number' ? summary.filesOver600Count : 0;
      return c400 > 0 || c600 > 0;
    }
    case 'migration_drift_fix': {
      // fileMissing runs (e.g. prod build without tools/) must NOT count as
      // findings — otherwise the circuit breaker would trip on a missing file.
      if (summary.fileMissing === true) return false;
      const total = typeof summary.totalDrift === 'number' ? summary.totalDrift : 0;
      return total > 0;
    }
    default:
      return false;
  }
}

// ── Re-export for external use ─────────────────────────

export { maybeAutoRecoverPaused } from './ga-circuit-breaker.js';
export { applyBranchCleanupFix, applyRelatedProjectScanFix } from './ga-scenario-fixes.js';
