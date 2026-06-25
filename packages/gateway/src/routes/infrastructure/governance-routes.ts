/**
 * Governance jobs API routes — observable surface for GA Loop state.
 *
 * GET  /governance/jobs              — list all governance jobs with loop state
 * GET  /governance/jobs/:jobType     — single job detail with phases
 * POST /governance/jobs/sweep        — trigger a manual sweep (supports ?dryRun=true)
 *
 * This is the primary operator visibility into the GA automation layer.
 * It exposes autoFix config, throttle counters, circuit breaker state,
 * last run results, and GA loop phases per job.
 */
import type { FastifyInstance } from 'fastify';
import {
  ensureGovernanceJobStore,
  listGovernanceJobs,
  seedGovernanceJobs,
  runGovernanceSweep,
} from '@los/agent';

const KNOWN_JOB_TYPES = [
  'consistency_audit', 'hotspot', 'architecture_drift',
  'memory_integrity', 'memory_retention', 'reflection',
  'branch_cleanup', 'related_project_scan', 'file_size',
  'ai_code_fix',
] as const;

interface GovernanceJobSummary {
  id: string;
  jobType: string;
  cadence: string;
  status: string;
  autoFixEnabled: boolean;
  maxAutoFixAttempts: number | null;
  stopCondition: string | null;
  circuitState: string;
  consecutiveNoOps: number;
  consecutiveFailures: number;
  lastRunAt: string | null;
  lastTaskRunId: string | null;
  resultKeys: string[];
  createdAt: string;
  updatedAt: string;
}

function toSummary(job: any): GovernanceJobSummary {
  return {
    id: job.id,
    jobType: job.jobType,
    cadence: job.cadence,
    status: job.status,
    autoFixEnabled: job.autoFix?.autoFixEnabled ?? false,
    maxAutoFixAttempts: job.autoFix?.maxAutoFixAttempts ?? null,
    stopCondition: job.autoFix?.stopCondition ?? null,
    circuitState: job.circuitState ?? 'closed',
    consecutiveNoOps: job.consecutiveNoOps ?? 0,
    consecutiveFailures: job.consecutiveFailures ?? 0,
    lastRunAt: job.lastRunAt ?? null,
    lastTaskRunId: job.lastTaskRunId ?? null,
    resultKeys: job.resultSummary ? Object.keys(job.resultSummary) : [],
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export function registerGovernanceRoutes(app: FastifyInstance): void {
  // ── GET /governance/jobs ────────────────────────────
  app.get('/governance/jobs', async (_req, reply) => {
    try {
      await ensureGovernanceJobStore();
      await seedGovernanceJobs();
      const jobs = await listGovernanceJobs({ limit: 50 });
      return reply.send({
        count: jobs.length,
        jobs: jobs.map(toSummary),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: msg });
    }
  });

  // ── GET /governance/jobs/:jobType ────────────────────
  app.get('/governance/jobs/:jobType', async (req, reply) => {
    const { jobType } = req.params as Record<string, string>;
    if (!(KNOWN_JOB_TYPES as readonly string[]).includes(jobType)) {
      return reply.status(400).send({
        error: `Unknown jobType "${jobType}". Known: ${KNOWN_JOB_TYPES.join(', ')}`,
      });
    }

    try {
      await ensureGovernanceJobStore();
      await seedGovernanceJobs();
      const jobs = await listGovernanceJobs({ jobType: jobType as any, limit: 5 });
      if (jobs.length === 0) {
        return reply.status(404).send({ error: `No governance job found for type: ${jobType}` });
      }

      const job = jobs[0];
      return reply.send({
        ...toSummary(job),
        dedupeKey: job.dedupeKey,
        autoFix: job.autoFix ? {
          autoFixEnabled: job.autoFix.autoFixEnabled,
          maxAutoFixAttempts: job.autoFix.maxAutoFixAttempts ?? 3,
          verificationCommands: job.autoFix.verificationCommands ?? [],
          stopCondition: job.autoFix.stopCondition ?? null,
          escalationCadence: job.autoFix.escalationCadence ?? 'after_retry',
        } : null,
        resultSummary: job.resultSummary ?? null,
        circuitOpenedAt: job.circuitOpenedAt ?? null,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: msg });
    }
  });

  // ── POST /governance/jobs/sweep ──────────────────────
  app.post('/governance/jobs/sweep', async (req, reply) => {
    try {
      const dryRun = (req.query as Record<string, string>)?.dryRun === 'true';
      await ensureGovernanceJobStore();
      await seedGovernanceJobs();
      const result = await runGovernanceSweep({ dryRun });
      return reply.send({
        dryRun: result.dryRun,
        jobsRun: result.jobsRun,
        jobsSkipped: result.jobsSkipped,
        findingsCreated: result.findingsCreated,
        errorCount: result.errors.length,
        errors: result.errors.slice(0, 10),
        details: result.results.map(r => ({
          jobType: r.jobType,
          jobId: r.jobId,
          durationMs: r.durationMs,
          gaLoop: (r.summary as any)?._gaLoop ?? null,
        })),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: msg });
    }
  });
}
