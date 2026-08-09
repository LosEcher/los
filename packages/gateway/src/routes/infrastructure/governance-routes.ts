/**
 * Governance jobs API routes — observable + operable surface for GA Loop.
 *
 * GET  /governance/jobs                   — list jobs with loop/circuit state
 * GET  /governance/jobs/:jobType          — single job detail + resultSummary
 * POST /governance/jobs/sweep             — manual sweep (operator; dryRun/force)
 * POST /governance/jobs/:jobType/run      — force one job type now (operator)
 * POST /governance/jobs/:jobType/status   — pause/resume (operator)
 */
import type { FastifyInstance } from 'fastify';
import {
  ensureGovernanceJobStore,
  listGovernanceJobs,
  seedGovernanceJobs,
  runGovernanceSweep,
  updateGovernanceJob,
  type GovernanceJobType,
  type GovernanceJobStatus,
} from '@los/agent';
import { requireOperator } from '../../request-context.js';

type GovernanceRouteDependencies = {
  listGovernanceJobs: typeof listGovernanceJobs;
  seedGovernanceJobs: typeof seedGovernanceJobs;
  runGovernanceSweep: typeof runGovernanceSweep;
  ensureGovernanceJobStore: typeof ensureGovernanceJobStore;
  updateGovernanceJob: typeof updateGovernanceJob;
};

const defaultDependencies: GovernanceRouteDependencies = {
  listGovernanceJobs,
  seedGovernanceJobs,
  runGovernanceSweep,
  ensureGovernanceJobStore,
  updateGovernanceJob,
};

/** Keep in sync with GovernanceJobType in @los/agent. */
const KNOWN_JOB_TYPES = [
  'consistency_audit', 'hotspot', 'architecture_drift',
  'memory_integrity', 'memory_retention', 'reflection',
  'branch_cleanup', 'related_project_scan', 'file_size',
  'supply_chain_audit', 'static_analysis', 'performance_audit',
  'migration_drift_fix', 'event_retention', 'code_topology_audit',
  'dead_letter', 'adversarial_review', 'self_bootstrap',
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
  nextRunAt: string | null;
  lastTaskRunId: string | null;
  findingCount: number | null;
  escalated: boolean;
  resultKeys: string[];
  createdAt: string;
  updatedAt: string;
}

function readFindingCount(summary: Record<string, unknown> | undefined): number | null {
  if (!summary) return null;
  if (typeof summary.findingCount === 'number') return summary.findingCount;
  const ga = summary._gaLoop;
  if (ga && typeof ga === 'object' && typeof (ga as any).findingCount === 'number') {
    return (ga as any).findingCount;
  }
  if (Array.isArray(summary.findings)) return summary.findings.length;
  return null;
}

function readEscalated(summary: Record<string, unknown> | undefined): boolean {
  if (!summary) return false;
  const ga = summary._gaLoop;
  if (ga && typeof ga === 'object' && (ga as any).escalated === true) return true;
  return summary.escalated === true;
}

function toSummary(job: any): GovernanceJobSummary {
  const resultSummary = (job.resultSummary ?? undefined) as Record<string, unknown> | undefined;
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
    nextRunAt: job.nextRunAt ?? null,
    lastTaskRunId: job.lastTaskRunId ?? null,
    findingCount: readFindingCount(resultSummary),
    escalated: readEscalated(resultSummary),
    resultKeys: resultSummary ? Object.keys(resultSummary) : [],
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function isKnownJobType(jobType: string): jobType is GovernanceJobType {
  return (KNOWN_JOB_TYPES as readonly string[]).includes(jobType);
}

async function forceJobDue(deps: GovernanceRouteDependencies, jobType: GovernanceJobType): Promise<number> {
  const jobs = await deps.listGovernanceJobs({ jobType, limit: 5 });
  const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  let updated = 0;
  for (const job of jobs) {
    if (job.status !== 'active' && job.status !== 'paused') continue;
    await deps.updateGovernanceJob(job.id, {
      lastRunAt: past,
      nextRunAt: past,
      // Force-run temporarily reactivates paused jobs for one operator-triggered pass.
      ...(job.status === 'paused' ? { status: 'active' as GovernanceJobStatus } : {}),
    }).catch(() => undefined);
    updated += 1;
  }
  return updated;
}

export function registerGovernanceRoutes(
  app: FastifyInstance,
  deps: GovernanceRouteDependencies = defaultDependencies,
): void {
  app.get('/governance/jobs', async (_req, reply) => {
    try {
      await deps.ensureGovernanceJobStore();
      await deps.seedGovernanceJobs();
      const jobs = await deps.listGovernanceJobs({ limit: 50 });
      const summaries = jobs.map(toSummary);
      const attention = summaries.filter(j =>
        j.escalated || j.circuitState === 'open' || j.status === 'paused' || (j.findingCount ?? 0) > 0,
      ).length;
      return reply.send({
        count: summaries.length,
        attentionCount: attention,
        knownJobTypes: KNOWN_JOB_TYPES,
        jobs: summaries,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: msg });
    }
  });

  app.get('/governance/jobs/:jobType', async (req, reply) => {
    const { jobType } = req.params as Record<string, string>;
    if (!isKnownJobType(jobType)) {
      return reply.status(400).send({
        error: `Unknown jobType "${jobType}". Known: ${KNOWN_JOB_TYPES.join(', ')}`,
      });
    }

    try {
      const jobs = await deps.listGovernanceJobs({ jobType, limit: 5 });
      if (jobs.length === 0) {
        return reply.status(404).send({ error: `No governance job found for type: ${jobType}` });
      }

      const job = jobs[0];
      return reply.send({
        ...toSummary(job),
        dedupeKey: job.dedupeKey,
        config: job.config ?? {},
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

  app.post('/governance/jobs/sweep', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    try {
      const dryRun = (req.query as Record<string, string>)?.dryRun === 'true';
      const force = (req.query as Record<string, string>)?.force === 'true';
      const body = (req.body ?? {}) as Record<string, unknown>;
      const jobType = typeof body.jobType === 'string' ? body.jobType : undefined;
      if (jobType && !isKnownJobType(jobType)) {
        return reply.status(400).send({ error: `Unknown jobType "${jobType}"` });
      }
      const jobTypes = jobType ? [jobType as GovernanceJobType] : undefined;
      await deps.ensureGovernanceJobStore();
      await deps.seedGovernanceJobs();
      if (force && jobType && isKnownJobType(jobType)) {
        await forceJobDue(deps, jobType);
      }
      const result = await deps.runGovernanceSweep({ dryRun, jobTypes });
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
          findingCount: readFindingCount(r.summary as Record<string, unknown>),
        })),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: msg });
    }
  });

  app.post('/governance/jobs/:jobType/run', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    const { jobType } = req.params as Record<string, string>;
    if (!isKnownJobType(jobType)) {
      return reply.status(400).send({ error: `Unknown jobType "${jobType}"` });
    }
    try {
      const dryRun = (req.query as Record<string, string>)?.dryRun === 'true';
      await deps.ensureGovernanceJobStore();
      await deps.seedGovernanceJobs();
      await forceJobDue(deps, jobType);
      const result = await deps.runGovernanceSweep({ dryRun, jobTypes: [jobType] });
      return reply.send({
        ok: true,
        jobType,
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
          findingCount: readFindingCount(r.summary as Record<string, unknown>),
        })),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: msg });
    }
  });

  app.post('/governance/jobs/:jobType/status', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    const { jobType } = req.params as Record<string, string>;
    if (!isKnownJobType(jobType)) {
      return reply.status(400).send({ error: `Unknown jobType "${jobType}"` });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const status = body.status;
    if (status !== 'active' && status !== 'paused') {
      return reply.status(400).send({ error: 'status must be active or paused' });
    }
    try {
      const jobs = await deps.listGovernanceJobs({ jobType, limit: 5 });
      if (jobs.length === 0) {
        return reply.status(404).send({ error: `No governance job found for type: ${jobType}` });
      }
      const updated = [];
      for (const job of jobs) {
        if (job.status === 'retired') continue;
        const next = await deps.updateGovernanceJob(job.id, { status });
        updated.push(toSummary(next));
      }
      return reply.send({ ok: true, status, count: updated.length, jobs: updated });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: msg });
    }
  });
}
