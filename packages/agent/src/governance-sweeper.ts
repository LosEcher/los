import { getLogger } from '@los/infra/logger';
import { ensureGovernanceJobStore } from './governance-jobs-schema.js';
import { listDueGovernanceJobs, updateGovernanceJob } from './governance-jobs-crud.js';
import { runJobAudit } from './governance-auditors.js';
import type {
  GovernanceJob,
  GovernanceJobType,
  GovernanceSweepJobResult,
  GovernanceSweepResult,
} from './governance-jobs-types.js';

const log = getLogger('governance-jobs');

async function createTodosFromFindings(
  job: GovernanceJob,
  summary: Record<string, unknown>,
  dryRun: boolean,
): Promise<number> {
  if (dryRun) return 0;

  let created = 0;
  try {
    const { createTodo } = await import('./todos.js');

    if (job.jobType === 'consistency_audit') {
      const todoRecon = summary.todoReconciliation as Record<string, unknown> | undefined;
      if (todoRecon && typeof todoRecon.seedOnly === 'number' && todoRecon.seedOnly > 0) {
        await createTodo({
          title: `Governance: ${todoRecon.seedOnly} seed-only todos detected`,
          description: `Consistency audit found ${todoRecon.seedOnly} todos defined in seeds but missing from DB, and ${todoRecon.dbOnly ?? 0} DB-only todos. Review the full report at ${job.id}.`,
          kind: 'task',
          status: 'backlog',
          priority: 'P1',
          source: 'governance_sweep',
          metadata: { sweepJobId: job.id, sweepJobType: job.jobType, auditType: 'seedOnly' },
        });
        created += 1;
      }
      if (todoRecon && typeof todoRecon.statusDrift === 'number' && todoRecon.statusDrift > 0) {
        await createTodo({
          title: `Governance: ${todoRecon.statusDrift} status drift(s) detected`,
          description: `Consistency audit found ${todoRecon.statusDrift} todo status mismatches between seeds and DB. Review the full report at ${job.id}.`,
          kind: 'task',
          status: 'backlog',
          priority: 'P1',
          source: 'governance_sweep',
          metadata: { sweepJobId: job.id, sweepJobType: job.jobType, auditType: 'statusDrift' },
        });
        created += 1;
      }
    }

    if (job.jobType === 'hotspot') {
      const cleanup = summary.runtimeCleanup as Record<string, unknown> | undefined;
      if (cleanup && typeof cleanup.illegalStatusCount === 'number' && cleanup.illegalStatusCount > 0) {
        await createTodo({
          title: `Governance: ${cleanup.illegalStatusCount} task runs with illegal status`,
          description: `Hotspot audit found ${cleanup.illegalStatusCount} illegal status task runs and ${cleanup.staleFixtureCount ?? 0} stale fixtures. Review the full report at ${job.id}.`,
          kind: 'task',
          status: 'backlog',
          priority: 'P1',
          source: 'governance_sweep',
          metadata: { sweepJobId: job.id, sweepJobType: job.jobType, auditType: 'illegalStatus' },
        });
        created += 1;
      }
    }

    if (job.jobType === 'architecture_drift') {
      await createTodo({
        title: `Governance: Architecture graph audit — ${summary.nodeCount ?? 0} nodes, ${summary.edgeCount ?? 0} edges`,
        description: `Architecture drift audit captured the current execution graph. Compare with previous baseline. Review at ${job.id}.`,
        kind: 'task',
        status: 'backlog',
        priority: 'P2',
        source: 'governance_sweep',
        metadata: { sweepJobId: job.id, sweepJobType: job.jobType, auditType: 'baseline' },
      });
      created += 1;
    }
  } catch (err) {
    log.warn(`Failed to create findings todo for ${job.jobType}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return created;
}

export async function runGovernanceSweep(opts?: {
  jobTypes?: GovernanceJobType[];
  dryRun?: boolean;
  tenantId?: string;
  projectId?: string;
  now?: Date;
}): Promise<GovernanceSweepResult> {
  const dryRun = opts?.dryRun !== false;
  await ensureGovernanceJobStore();

  const dueJobs = await listDueGovernanceJobs({
    jobTypes: opts?.jobTypes,
    tenantId: opts?.tenantId,
    projectId: opts?.projectId,
    now: opts?.now,
  });

  if (dueJobs.length === 0) {
    return { dryRun, jobsRun: 0, jobsSkipped: 0, findingsCreated: 0, errors: [], results: [] };
  }

  const results: GovernanceSweepJobResult[] = [];
  const errors: string[] = [];
  let findingsCreated = 0;

  for (const job of dueJobs) {
    const started = Date.now();
    try {
      const summary = await runJobAudit(job, dryRun);
      results.push({
        jobId: job.id,
        jobType: job.jobType,
        summary,
        durationMs: Date.now() - started,
      });

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
  }

  return { dryRun, jobsRun: results.length, jobsSkipped: dueJobs.length - results.length, findingsCreated, errors, results };
}
