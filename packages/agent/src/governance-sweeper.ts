import { getLogger } from '@los/infra/logger';
import { ensureGovernanceJobStore } from './governance-jobs-schema.js';
import { listDueGovernanceJobs, updateGovernanceJob, updateGovernanceJobState } from './governance-jobs-crud.js';
import { runJobAudit } from './governance-auditors.js';
import { runGaLoop, maybeAutoRecoverPaused } from './ga-loop-runner.js';
import { evaluateLoopGate } from './ga-circuit-breaker.js';
import { computeNextRunAt } from './governance-jobs-types.js';
import { createTodosFromFindings } from './governance-sweep-todos.js';
import { appendSessionEvent } from './session-events.js';
import { randomUUID } from 'node:crypto';
import type {
  GovernanceJobType,
  GovernanceSweepJobResult,
  GovernanceSweepResult,
  GaLoopResult,
} from './governance-jobs-types.js';

const log = getLogger('governance-jobs');

export async function runGovernanceSweep(opts?: {
  jobTypes?: GovernanceJobType[];
  dryRun?: boolean;
  tenantId?: string;
  projectId?: string;
  now?: Date;
}): Promise<GovernanceSweepResult> {
  const dryRun = opts?.dryRun !== false;
  const tenantId = opts?.tenantId;
  const projectId = opts?.projectId;
  await ensureGovernanceJobStore();

  const dueJobs = await listDueGovernanceJobs({
    jobTypes: opts?.jobTypes,
    tenantId,
    projectId,
    now: opts?.now,
  });

  if (dueJobs.length === 0) {
    return { dryRun, jobsRun: 0, jobsSkipped: 0, findingsCreated: 0, errors: [], results: [] };
  }

  const sweepSessionId = `gov-sweep-${randomUUID()}`;
  try {
    await appendSessionEvent({
      sessionId: sweepSessionId,
      type: 'governance.sweep.started',
      source: 'governance',
      tenantId,
      projectId,
      payload: { dryRun, jobCount: dueJobs.length },
    });
  } catch (err) { log.warn(`Session event emission failed: ${err instanceof Error ? err.message : String(err)}`); }

  const results: GovernanceSweepJobResult[] = [];
  const errors: string[] = [];
  let findingsCreated = 0;

  for (const job of dueJobs) {
    const started = Date.now();
    let gateDecision: ReturnType<typeof evaluateLoopGate> | null = null;

    // Best-effort per-job start event
    try {
      await appendSessionEvent({
        sessionId: sweepSessionId,
        type: 'governance.job.started',
        source: 'governance',
        tenantId: job.tenantId ?? undefined,
        projectId: job.projectId ?? undefined,
        payload: { jobId: job.id, jobType: job.jobType, dryRun, hasAutoFix: !!job.autoFix?.autoFixEnabled },
      });
    } catch (err) { log.warn(`Session event emission failed: ${err instanceof Error ? err.message : String(err)}`); }

    try {
      // ── Auto-recover paused jobs whose circuit breaker has expired ──
      if (maybeAutoRecoverPaused(job)) {
        try {
          await updateGovernanceJob(job.id, {
            status: 'active',
            lastRunAt: new Date().toISOString(),
          });
          await updateGovernanceJobState(job.id, {
            circuitState: 'closed',
            consecutiveFailures: 0,
            circuitOpenedAt: null,
          });
          log.info(`GA loop: auto-recovered paused job ${job.jobType} (${job.id})`);
          job.status = 'active';
          job.circuitState = 'closed';
        } catch (err) {
          log.warn(`GA loop: failed to auto-recover job ${job.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // ── Gate check: skip if circuit broken or no-op throttled ──
      gateDecision = evaluateLoopGate(job);
      if (gateDecision.action === 'skip') {
        log.info(`GA loop: skipping ${job.jobType} (${job.id}) — ${gateDecision.reason}`);
        continue;
      }

      try {
        // ── GA Loop path: job has autoFix enabled ──────────
        if (job.autoFix?.autoFixEnabled && !dryRun) {
          const loopResult: GaLoopResult = await runGaLoop({ job, dryRun: false, sessionId: sweepSessionId });
          const summary = loopResult.auditSummary;

          results.push({
            jobId: job.id,
            jobType: job.jobType,
            summary: {
              ...summary,
              _gaLoop: {
                fixApplied: loopResult.fixApplied,
                fixSucceeded: loopResult.fixSucceeded,
                verificationPassed: loopResult.verificationPassed,
                retried: loopResult.retried,
                escalated: loopResult.escalated,
                phases: loopResult.phases.map(p => `${p.phase}(${p.attemptNumber})`),
              },
            },
            durationMs: Date.now() - started,
          });

          // Apply gate decisions (downgrade / pause) from throttle
          if (gateDecision.action === 'downgrade' && gateDecision.newCadence) {
            await updateGovernanceJob(job.id, { cadence: gateDecision.newCadence });
            log.info(`GA loop: downgraded ${job.jobType} cadence from ${job.cadence} to ${gateDecision.newCadence}`);
          }
          if (gateDecision.action === 'pause') {
            await updateGovernanceJob(job.id, { status: 'paused' });
            log.info(`GA loop: paused ${job.jobType} (${gateDecision.reason})`);
          }

          if (loopResult.fixSucceeded && !loopResult.escalated) findingsCreated += 1;
          continue;
        }

        // ── Traditional path: audit + createTodos (dryRun or no autoFix) ──
        const summary = await runJobAudit(job, dryRun);
        results.push({
          jobId: job.id,
          jobType: job.jobType,
          summary,
          durationMs: Date.now() - started,
        });

        // Detect internal audit errors (caught by the auditor itself, not thrown)
        if (!dryRun && summary && typeof summary.error === 'string') {
          const msg = `${job.jobType} (${job.id}): ${summary.error}`;
          errors.push(msg);
          log.warn(`Sweep job internal error: ${msg}`);
        }

        if (!dryRun) {
          await updateGovernanceJob(job.id, {
            lastRunAt: new Date().toISOString(),
            resultSummary: summary,
          });
        }

        const created = await createTodosFromFindings(job, summary, dryRun);
        findingsCreated += created;
      } catch (err) {
        const msg = `${job.jobType} (${job.id}): ${err instanceof Error ? err.message : String(err)}`;
        errors.push(msg);
        log.warn(`Sweep job failed: ${msg}`);
      }
    } finally {
      // Best-effort per-job completion event
      try {
        await appendSessionEvent({
          sessionId: sweepSessionId,
          type: 'governance.job.completed',
          source: 'governance',
          tenantId: job.tenantId ?? undefined,
          projectId: job.projectId ?? undefined,
          payload: { jobId: job.id, jobType: job.jobType, durationMs: Date.now() - started },
        });
      } catch (err) { log.warn(`Session event emission failed: ${err instanceof Error ? err.message : String(err)}`); }

      // Reschedule next_run_at so the claim loop keeps picking this job up.
      // Mirrors runGovernanceSweepLoop (governance-wake.ts): every job we
      // touched — skipped, run, or errored — gets next_run_at pushed forward
      // by its (effective) cadence. Without this, a manual sweep leaves
      // next_run_at stale or NULL and the job can be orphaned from the timer
      // (the branch_cleanup incident: only ran when chat triggered governance).
      if (!dryRun && gateDecision) {
        const effectiveCadence = gateDecision.newCadence ?? job.cadence;
        try {
          await updateGovernanceJob(job.id, { nextRunAt: computeNextRunAt(effectiveCadence) });
        } catch (err) {
          log.warn(`Failed to set next_run_at for ${job.jobType}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  // ── Drift detection pass ──
  let driftReport: Awaited<ReturnType<typeof import('./governance-drift-sweeper.js').sweepGovernanceDrift>> | null = null;
  try {
    const { sweepGovernanceDrift: runDrift } = await import('./governance-drift-sweeper.js');
    driftReport = await runDrift({ dryRun, tenantId, projectId });
  } catch (err) {
    log.warn(`Drift sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Best-effort completion event
  try {
    await appendSessionEvent({
      sessionId: sweepSessionId,
      type: 'governance.sweep.completed',
      source: 'governance',
      tenantId,
      projectId,
      payload: {
        dryRun, jobsRun: results.length, jobsSkipped: dueJobs.length - results.length,
        findingsCreated, errorCount: errors.length, hasDrift: !!driftReport,
      },
    });
  } catch (err) { log.warn(`Session event emission failed: ${err instanceof Error ? err.message : String(err)}`); }

  return {
    dryRun, jobsRun: results.length, jobsSkipped: dueJobs.length - results.length, findingsCreated, errors, results,
    ...(driftReport ? { drift: driftReport } : {}),
  };
}

// Re-export wake module for gateway use
export { runGovernanceSweepLoop, setupGovernanceWake } from './governance-wake.js';
// Re-export the todo creator (extracted to governance-sweep-todos.ts) so
// existing importers (governance-wake.ts) keep resolving it from here.
export { createTodosFromFindings };
