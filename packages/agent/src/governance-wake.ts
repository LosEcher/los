/**
 * Governance sweep wake mechanism — PG LISTEN + EventBus + fallback interval.
 *
 * Extracted from governance-sweeper.ts to keep both files under 600 lines.
 */
import { getLogger } from '@los/infra/logger';
import { getDb } from '@los/infra/db';
import { ensureGovernanceJobStore } from './governance-jobs-schema.js';
import { claimNextDueJob, listDueGovernanceJobs, updateGovernanceJob, updateGovernanceJobState } from './governance-jobs-crud.js';
import { runJobAudit } from './governance-auditors.js';
import { runGaLoop, maybeAutoRecoverPaused } from './ga-loop-runner.js';
import { evaluateLoopGate } from './ga-circuit-breaker.js';
import { createTodosFromFindings } from './governance-sweeper.js';
import { eventBus } from './event-bus.js';
import { computeNextRunAt } from './governance-jobs-types.js';
import { appendSessionEvent } from './session-events.js';
import { randomUUID } from 'node:crypto';
import type {
  GovernanceJob,
  GovernanceSweepJobResult,
  GovernanceSweepResult,
  GaLoopResult,
} from './governance-jobs-types.js';

const log = getLogger('governance-jobs');

// ── Single-job runner (extracted for claim loop) ──────────

async function runOneSweepJob(job: GovernanceJob, dryRun: boolean, sessionId: string): Promise<{
  jobResult: GovernanceSweepJobResult;
  findingsCreated: number;
  error?: string;
}> {
  const started = Date.now();

  // Best-effort start event — must not abort the sweep
  try {
    await appendSessionEvent({
      sessionId,
      type: 'governance.job.started',
      source: 'governance',
      tenantId: job.tenantId ?? undefined,
      projectId: job.projectId ?? undefined,
      payload: { jobId: job.id, jobType: job.jobType, dryRun, hasAutoFix: !!job.autoFix?.autoFixEnabled },
    });
  } catch { /* best-effort */ }

  if (maybeAutoRecoverPaused(job)) {
    try {
      await updateGovernanceJob(job.id, { status: 'active', lastRunAt: new Date().toISOString() });
      await updateGovernanceJobState(job.id, {
        circuitState: 'closed', consecutiveFailures: 0, circuitOpenedAt: null,
      });
      log.info(`GA loop: auto-recovered paused job ${job.jobType} (${job.id})`);
      job.status = 'active';
      job.circuitState = 'closed';
    } catch (err) {
      log.warn(`GA loop: failed to auto-recover job ${job.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const gateDecision = evaluateLoopGate(job);
  if (gateDecision.action === 'skip') {
    log.info(`GA loop: skipping ${job.jobType} (${job.id}) — ${gateDecision.reason}`);
    const result = {
      jobResult: { jobId: job.id, jobType: job.jobType, summary: { skipped: true, reason: gateDecision.reason }, durationMs: Date.now() - started },
      findingsCreated: 0,
    };
    emitJobCompleted(sessionId, job, started, result.jobResult, 0, undefined);
    return result;
  }

  let jobResult: GovernanceSweepJobResult;
  let findingsCreated = 0;
  let error: string | undefined;

  try {
    if (job.autoFix?.autoFixEnabled && !dryRun) {
      const loopResult: GaLoopResult = await runGaLoop({ job, dryRun: false, sessionId });
      const summary = loopResult.auditSummary;

      if (gateDecision.action === 'downgrade' && gateDecision.newCadence) {
        await updateGovernanceJob(job.id, { cadence: gateDecision.newCadence });
      }
      if (gateDecision.action === 'pause') {
        await updateGovernanceJob(job.id, { status: 'paused' });
      }

      if (loopResult.fixSucceeded && !loopResult.escalated) findingsCreated += 1;

      jobResult = {
        jobId: job.id, jobType: job.jobType,
        summary: {
          ...summary,
          _gaLoop: {
            fixApplied: loopResult.fixApplied, fixSucceeded: loopResult.fixSucceeded,
            verificationPassed: loopResult.verificationPassed, retried: loopResult.retried,
            escalated: loopResult.escalated,
            phases: loopResult.phases.map(p => `${p.phase}(${p.attemptNumber})`),
          },
        },
        durationMs: Date.now() - started,
      };
    } else {
      const summary = await runJobAudit(job, dryRun);

      if (!dryRun && summary && typeof summary.error === 'string') {
        error = `${job.jobType} (${job.id}): ${summary.error}`;
        log.warn(`Sweep job internal error: ${error}`);
      }

      if (!dryRun) {
        await updateGovernanceJob(job.id, { lastRunAt: new Date().toISOString(), resultSummary: summary });
      }

      const created = await createTodosFromFindings(job, summary, dryRun);
      findingsCreated += created;

      jobResult = { jobId: job.id, jobType: job.jobType, summary, durationMs: Date.now() - started };
    }
  } catch (err) {
    const msg = `${job.jobType} (${job.id}): ${err instanceof Error ? err.message : String(err)}`;
    log.warn(`Sweep job failed: ${msg}`);
    error = msg;
    jobResult = { jobId: job.id, jobType: job.jobType, summary: { error: msg }, durationMs: Date.now() - started };
    findingsCreated = 0;
  }

  emitJobCompleted(sessionId, job, started, jobResult, findingsCreated, error);
  return { jobResult, findingsCreated, error };
}

/** Best-effort completion event — must not abort the sweep. */
async function emitJobCompleted(
  sessionId: string,
  job: GovernanceJob,
  started: number,
  jobResult: GovernanceSweepJobResult,
  findingsCreated: number,
  error: string | undefined,
): Promise<void> {
  try {
    await appendSessionEvent({
      sessionId,
      type: 'governance.job.completed',
      source: 'governance',
      tenantId: job.tenantId ?? undefined,
      projectId: job.projectId ?? undefined,
      payload: {
        jobId: job.id, jobType: job.jobType, durationMs: Date.now() - started,
        findingsCreated, hasError: !!error, error,
        hasFindings: !!jobResult.summary,
      },
    });
  } catch { /* best-effort */ }
}

// ── Claim loop (PG-queue mode) ────────────────────────────

export async function runGovernanceSweepLoop(opts?: {
  dryRun?: boolean; tenantId?: string; projectId?: string;
}): Promise<GovernanceSweepResult> {
  const dryRun = opts?.dryRun !== false;
  const tenantId = opts?.tenantId;
  const projectId = opts?.projectId;
  await ensureGovernanceJobStore();

  // Pre-count due jobs for the start event (best-effort)
  let dueCount = 0;
  try { dueCount = (await listDueGovernanceJobs({ tenantId, projectId })).length; } catch { /* ok */ }

  const sweepSessionId = `gov-sweep-${randomUUID()}`;
  try {
    await appendSessionEvent({
      sessionId: sweepSessionId,
      type: 'governance.sweep.started',
      source: 'governance',
      tenantId,
      projectId,
      payload: { dryRun, jobCount: dueCount },
    });
  } catch { /* best-effort */ }

  const results: GovernanceSweepJobResult[] = [];
  const errors: string[] = [];
  let jobsRun = 0;
  let findingsCreated = 0;

  while (true) {
    const job = await claimNextDueJob();
    if (!job) break;

    const { jobResult, findingsCreated: f, error } = await runOneSweepJob(job, dryRun, sweepSessionId);
    results.push(jobResult);
    jobsRun += 1;
    findingsCreated += f;
    if (error) errors.push(error);

    const gateDecision = evaluateLoopGate(job);
    const effectiveCadence = gateDecision.newCadence ?? job.cadence;
    try {
      await updateGovernanceJob(job.id, { nextRunAt: computeNextRunAt(effectiveCadence) });
    } catch (err) {
      log.warn(`Failed to set next_run_at for ${job.jobType}: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      await getDb().notify('governance_sweep', JSON.stringify({ jobType: job.jobType, jobId: job.id, action: 'job_done' }));
    } catch { /* best-effort */ }
  }

  let driftReport: any = null;
  try {
    const { sweepGovernanceDrift: runDrift } = await import('./governance-drift-sweeper.js');
    driftReport = await runDrift({ dryRun, tenantId: opts?.tenantId, projectId: opts?.projectId });
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
        dryRun, jobsRun, jobsSkipped: 0, findingsCreated,
        errorCount: errors.length, hasDrift: !!driftReport,
      },
    });
  } catch { /* best-effort */ }

  return {
    dryRun, jobsRun, jobsSkipped: 0, findingsCreated, errors, results,
    ...(driftReport ? { drift: driftReport } : {}),
  };
}

// ── Wake mechanism (PG NOTIFY + EventBus + fallback interval) ──

let _wakeSetup = false;

export function setupGovernanceWake(opts?: { tenantId?: string; projectId?: string }): () => void {
  if (_wakeSetup) return () => {};
  _wakeSetup = true;

  const runLoop = () => {
    runGovernanceSweepLoop({ dryRun: false, ...opts }).catch((err) => {
      log.warn(`Governance sweep loop failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  const unsubEvent = eventBus.on('governance:sweep-wake', runLoop);

  let pgClient: any;
  let listenSetup = false;
  const setupListen = async () => {
    if (listenSetup) return;
    try {
      const { getPool } = await import('@los/infra/db');
      pgClient = await getPool().connect();
      await pgClient.query('LISTEN governance_sweep');
      pgClient.on('notification', () => {
        eventBus.emit('governance:sweep-wake', {} as any);
      });
      listenSetup = true;
      log.info('Governance wake: PG LISTEN active on governance_sweep');
    } catch (err) {
      log.warn(`Governance wake LISTEN setup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const FALLBACK_MS = 10 * 60 * 1000;
  const fallbackTimer = setInterval(runLoop, FALLBACK_MS);

  setupListen().catch(() => {});

  return () => {
    unsubEvent();
    clearInterval(fallbackTimer);
    if (pgClient) { pgClient.release().catch(() => {}); }
    _wakeSetup = false;
  };
}
