/**
 * @los/agent/governance-sweep-todos — create operator TODOs from sweep findings.
 *
 * Extracted from governance-sweeper.ts to keep that file under the 400-line
 * gate. Pure mapping from a job's audit summary to backlog TODOs; depends only
 * on createTodo + the per-jobType todo creators (dynamic imports).
 */
import { getLogger } from '@los/infra/logger';
import type { GovernanceJob } from './governance-jobs-types.js';

const log = getLogger('governance-jobs');

export async function createTodosFromFindings(
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

    if (job.jobType === 'reflection') {
      const tasksWithout = typeof summary.tasksWithoutReflection === 'number' ? summary.tasksWithoutReflection : 0;
      const tasksWith = typeof summary.tasksWithReflection === 'number' ? summary.tasksWithReflection : 0;
      const coverage = typeof summary.coverage === 'string' ? summary.coverage : 'N/A';

      if (tasksWithout > 0) {
        await createTodo({
          title: `Governance: ${tasksWithout} blocked/failed task(s) missing reflection metadata`,
          description: `Reflection audit: ${tasksWith} tasks have reflection, ${tasksWithout} without (coverage: ${coverage}). Recovery types used: ${summary.recoveryTypes || 'none'}. ${summary.recoveryTodosCreated ?? 0} recovery todos created. Review at ${job.id}.`,
          kind: 'task',
          status: 'backlog',
          priority: 'P1',
          source: 'governance_sweep',
          metadata: { sweepJobId: job.id, sweepJobType: job.jobType, auditType: 'missingReflection' },
        });
        created += 1;
      }

      // Always create a summary todo for visibility into reflection health
      if (tasksWith + tasksWithout > 0) {
        await createTodo({
          title: `Governance: Reflection coverage ${coverage} (${tasksWith}/${tasksWith + tasksWithout} tasks)`,
          description: `Reflection audit summary: ${tasksWith} tasks with reflection, ${tasksWithout} without. Recovery types: ${summary.recoveryTypes || 'none'}. Recovery todos: ${summary.recoveryTodosCreated ?? 0}. Review at ${job.id}.`,
          kind: 'task',
          status: 'backlog',
          priority: 'P3',
          source: 'governance_sweep',
          metadata: { sweepJobId: job.id, sweepJobType: job.jobType, auditType: 'reflectionSummary' },
        });
        created += 1;
      }
    }

    if (job.jobType === 'branch_cleanup') {
      const { createBranchCleanupTodos } = await import('./governance-sweeper-branch-todos.js');
      created += await createBranchCleanupTodos(job, summary);
    }
    if (job.jobType === 'migration_drift_fix') {
      const { createMigrationDriftTodos } = await import('./governance-sweeper-migration-todos.js');
      created += await createMigrationDriftTodos(job, summary);
    }
    if (job.jobType === 'related_project_scan') {
      const { createRelatedProjectScanTodos } = await import('./governance-sweep-related-project-todos.js');
      created += await createRelatedProjectScanTodos(job, summary);
    }
    if (job.jobType === 'file_size') {
      const { createFileSizeTodos } = await import('./governance-sweeper-file-size-todos.js');
      created += await createFileSizeTodos(job, summary);
    }
    if (job.jobType === 'code_topology_audit') {
      const { createCodeTopologyTodos } = await import('./governance-sweep-code-topology-todos.js');
      created += await createCodeTopologyTodos(job, summary);
    }
  } catch (err) {
    log.warn(`Failed to create findings todo for ${job.jobType}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return created;
}
