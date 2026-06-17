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

    if (job.jobType === 'memory_integrity') {
      const checks = Array.isArray(summary.checks) ? summary.checks as Array<{ name: string; passed: boolean; detail: string; severity: string }> : [];

      // Stale approved candidates
      const candidateCheck = checks.find(c => c.name === 'candidate-status-consistency');
      if (candidateCheck && !candidateCheck.passed) {
        await createTodo({
          title: `Governance: Stale procedural candidates need review`,
          description: `Memory integrity audit: ${candidateCheck.detail}. Promote to 'active' or retire them.`,
          kind: 'task',
          status: 'backlog',
          priority: 'P2',
          source: 'governance_sweep',
          metadata: { sweepJobId: job.id, sweepJobType: job.jobType, auditType: 'staleCandidates' },
        });
        created += 1;
      }

      // Uncompacted sessions
      const compactionCheck = checks.find(c => c.name === 'compaction-session-validity');
      if (compactionCheck && !compactionCheck.passed) {
        await createTodo({
          title: `Governance: Uncompacted observation sessions detected`,
          description: `Memory integrity audit: ${compactionCheck.detail}.`,
          kind: 'task',
          status: 'backlog',
          priority: 'P3',
          source: 'governance_sweep',
          metadata: { sweepJobId: job.id, sweepJobType: job.jobType, auditType: 'uncompactedSessions' },
        });
        created += 1;
      }

      // Orphaned compactions
      const orphanCheck = checks.find(c => c.name === 'orphaned-compactions');
      if (orphanCheck && !orphanCheck.passed) {
        await createTodo({
          title: `Governance: Orphaned memory compactions detected`,
          description: `Memory integrity audit: ${orphanCheck.detail}.`,
          kind: 'task',
          status: 'backlog',
          priority: 'P3',
          source: 'governance_sweep',
          metadata: { sweepJobId: job.id, sweepJobType: job.jobType, auditType: 'orphanedCompactions' },
        });
        created += 1;
      }

      // High observation-to-compaction ratio
      const ratioCheck = checks.find(c => c.name === 'observation-compaction-ratio');
      if (ratioCheck && !ratioCheck.passed) {
        await createTodo({
          title: `Governance: High observation-to-compaction ratio`,
          description: `Memory integrity audit: ${ratioCheck.detail}. Consider compacting old sessions.`,
          kind: 'task',
          status: 'backlog',
          priority: 'P3',
          source: 'governance_sweep',
          metadata: { sweepJobId: job.id, sweepJobType: job.jobType, auditType: 'obsCompactionRatio' },
        });
        created += 1;
      }

      // If nothing specific failed but there are warnings, create a summary todo
      if (created === 0) {
        const warnCount = typeof summary.warnCount === 'number' ? summary.warnCount : 0;
        if (warnCount > 0) {
          const failedChecks = Array.isArray(summary.failedChecks) ? summary.failedChecks as string[] : [];
          await createTodo({
            title: `Governance: Memory integrity audit — ${warnCount} warning(s)`,
            description: `Memory integrity audit completed with ${warnCount} warnings: ${failedChecks.join(', ') || 'none'}. Review at ${job.id}.`,
            kind: 'task',
            status: 'backlog',
            priority: 'P3',
            source: 'governance_sweep',
            metadata: { sweepJobId: job.id, sweepJobType: job.jobType, auditType: 'summary' },
          });
          created += 1;
        }
      }
    }

    if (job.jobType === 'memory_retention') {
      const archivedCount = typeof summary.archivedCount === 'number' ? summary.archivedCount : 0;
      const deletedCount = typeof summary.deletedCount === 'number' ? summary.deletedCount : 0;
      const retentionErrors = Array.isArray(summary.errors) ? summary.errors as string[] : [];

      if (retentionErrors.length > 0) {
        await createTodo({
          title: `Governance: Memory retention cleanup had ${retentionErrors.length} error(s)`,
          description: `Retention audit errors: ${retentionErrors.join('; ')}. Review at ${job.id}.`,
          kind: 'task',
          status: 'backlog',
          priority: 'P1',
          source: 'governance_sweep',
          metadata: { sweepJobId: job.id, sweepJobType: job.jobType, auditType: 'retentionErrors' },
        });
        created += 1;
      }

      if (archivedCount > 0 || deletedCount > 0) {
        await createTodo({
          title: `Governance: Memory retention cleaned ${archivedCount} archived + ${deletedCount} deleted observations`,
          description: `Retention audit archived ${archivedCount} and hard-deleted ${deletedCount} observations. Review at ${job.id}.`,
          kind: 'task',
          status: 'backlog',
          priority: 'P3',
          source: 'governance_sweep',
          metadata: { sweepJobId: job.id, sweepJobType: job.jobType, auditType: 'retentionSummary' },
        });
        created += 1;
      }
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
