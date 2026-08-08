/**
 * @los/agent/governance-sweep-todos — create operator TODOs from sweep findings.
 *
 * Extracted from governance-sweeper.ts to keep that file under the 400-line
 * gate. Pure mapping from a job's audit summary to backlog TODOs; depends only
 * on createTodo + the per-jobType todo creators (dynamic imports).
 */
import { createHash } from 'node:crypto';
import { getLogger } from '@los/infra/logger';
import type { GovernanceJob } from './governance-jobs-types.js';
import type { CreateTodoInput, TodoPriority } from './todo-types.js';

const log = getLogger('governance-jobs');

type FindingTodoInput = Omit<CreateTodoInput, 'id' | 'tenantId' | 'projectId' | 'dedupeKey'>;
type TodoOperations = typeof import('./todos.js');

function findingIdentity(job: GovernanceJob, auditType: string) {
  const tenantId = job.tenantId ?? 'local';
  const projectId = job.projectId ?? 'los';
  const scopeHash = createHash('sha256')
    .update(`${tenantId}\0${projectId}\0${auditType}`)
    .digest('hex')
    .slice(0, 12);
  return {
    id: `todo-governance-${auditType}-${scopeHash}`,
    tenantId,
    projectId,
    dedupeKey: `governance-finding:${tenantId}:${projectId}:${auditType}`,
  };
}

async function syncFindingTodo(
  todos: TodoOperations,
  job: GovernanceJob,
  auditType: string,
  active: boolean,
  input: FindingTodoInput,
): Promise<number> {
  const identity = findingIdentity(job, auditType);
  const existing = await todos.loadTodo(identity.id);
  if (!active) {
    if (existing && !existing.archivedAt) {
      await todos.archiveTodo(identity.id, `governance finding resolved: ${auditType}`);
    }
    return 0;
  }

  const todo = await todos.createTodo({ ...identity, ...input });
  if (todo.archivedAt) await todos.unarchiveTodo(todo.id);
  return 1;
}

/**
 * Dimension→todo mapping for the self_bootstrap / adversarial_review jobs.
 * Both jobs emit `findings: [{ dimension, severity, detail }]`; every known
 * dimension is synced each run so resolved findings archive their todo.
 */
interface DimensionTodoSpec {
  auditType: string;
  priority: TodoPriority;
  title: (count: number, dimension: string) => string;
  description: (count: number, detail: string) => string;
}

const DIMENSION_TODO_SPECS: Record<string, Record<string, DimensionTodoSpec>> = {
  self_bootstrap: {
    quality_degradation: {
      auditType: 'qualityDegradation',
      priority: 'P1',
      title: (count) => `Bootstrap: ${count} quality degradation finding(s)`,
      description: (count, detail) =>
        `Self-bootstrap audit found ${count} quality degradation signal(s) in daily_agent_quality_snapshots. ${detail}`,
    },
    todo_lifecycle: {
      auditType: 'todoStaleness',
      priority: 'P2',
      title: (count) => `Bootstrap: ${count} stale in_progress todo(s) need refresh`,
      description: (count, detail) =>
        `Self-bootstrap audit found ${count} in_progress todo(s) older than staleDays without a recent statusReview. ${detail}`,
    },
    todo_outcome_drift: {
      auditType: 'todoOutcomeDrift',
      priority: 'P1',
      title: (count) => `Bootstrap: ${count} todo(s) lag terminal task outcomes (AP12)`,
      description: (count, detail) =>
        `Self-bootstrap audit found ${count} open todo(s) whose linked task_run or feed-analysis dispatch is already terminal. ${detail}`,
    },
  },
  adversarial_review: {
    metric_semantics: {
      auditType: 'metricSemantics',
      priority: 'P1',
      title: (count) => `Adversarial: ${count} telemetry metric-semantics finding(s)`,
      description: (count, detail) => `Adversarial review found ${count} metric-semantics issue(s). ${detail}`,
    },
    process_residue: {
      auditType: 'processResidue',
      priority: 'P1',
      title: (count) => `Adversarial: ${count} lingering gateway process(es)`,
      description: (count, detail) => `Adversarial review found ${count} process-residue issue(s). ${detail}`,
    },
    stuck_approval: {
      auditType: 'stuckApproval',
      priority: 'P1',
      title: (count) => `Adversarial: ${count} stuck approval queue(s)`,
      description: (count, detail) => `Adversarial review found ${count} stuck-approval issue(s). ${detail}`,
    },
    provider_ready_vs_usable: {
      auditType: 'providerReadyVsUsable',
      priority: 'P1',
      title: (count) => `Adversarial: ${count} ready-but-unused provider(s)`,
      description: (count, detail) => `Adversarial review found ${count} provider(s) ready per discovery with 0 telemetry calls. ${detail}`,
    },
  },
};

export async function createTodosFromFindings(
  job: GovernanceJob,
  summary: Record<string, unknown>,
  dryRun: boolean,
): Promise<number> {
  if (dryRun) return 0;

  let created = 0;
  try {
    const todos = await import('./todos.js');
    const { createTodo } = todos;

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
      const illegalStatusCount = typeof cleanup?.illegalStatusCount === 'number' ? cleanup.illegalStatusCount : 0;
      const staleFixtureCount = typeof cleanup?.staleFixtureCount === 'number' ? cleanup.staleFixtureCount : 0;
      const staleTaskFixtureCount = typeof cleanup?.staleTaskFixtureCount === 'number'
        ? cleanup.staleTaskFixtureCount
        : staleFixtureCount;
      const staleRunSpecFixtureCount = typeof cleanup?.staleRunSpecFixtureCount === 'number'
        ? cleanup.staleRunSpecFixtureCount
        : 0;

      created += await syncFindingTodo(todos, job, 'illegalRuntimeStatus', illegalStatusCount > 0, {
          title: `Governance: ${illegalStatusCount} task runs with illegal status`,
          description: `Hotspot audit found ${illegalStatusCount} task runs with illegal status. Review the full report at ${job.id}.`,
          kind: 'task',
          status: 'backlog',
          priority: 'P1',
          source: 'governance_sweep',
          metadata: { sweepJobId: job.id, sweepJobType: job.jobType, auditType: 'illegalRuntimeStatus' },
      });
      created += await syncFindingTodo(todos, job, 'staleRuntimeFixtures', staleFixtureCount > 0, {
          title: `Governance: ${staleFixtureCount} stale runtime fixture(s) need review`,
          description: `Hotspot audit found ${staleTaskFixtureCount} stale task run fixture(s) and ${staleRunSpecFixtureCount} stale run spec fixture(s). Cleanup remains manual-only; review the full report at ${job.id}.`,
          kind: 'task',
          status: 'backlog',
          priority: 'P1',
          source: 'governance_sweep',
          metadata: { sweepJobId: job.id, sweepJobType: job.jobType, auditType: 'staleRuntimeFixtures' },
      });
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

      created += await syncFindingTodo(todos, job, 'missingReflection', tasksWithout > 0, {
          title: `Governance: ${tasksWithout} blocked/failed task(s) missing reflection metadata`,
          description: `Reflection audit: ${tasksWith} tasks have reflection, ${tasksWithout} without (coverage: ${coverage}). Recovery types used: ${summary.recoveryTypes || 'none'}. ${summary.recoveryTodosCreated ?? 0} recovery todos created. Review at ${job.id}.`,
          kind: 'task',
          status: 'backlog',
          priority: 'P1',
          source: 'governance_sweep',
          metadata: { sweepJobId: job.id, sweepJobType: job.jobType, auditType: 'missingReflection' },
      });

      created += await syncFindingTodo(todos, job, 'reflectionSummary', tasksWith + tasksWithout > 0, {
          title: `Governance: Reflection coverage ${coverage} (${tasksWith}/${tasksWith + tasksWithout} tasks)`,
          description: `Reflection audit summary: ${tasksWith} tasks with reflection, ${tasksWithout} without. Recovery types: ${summary.recoveryTypes || 'none'}. Recovery todos: ${summary.recoveryTodosCreated ?? 0}. Review at ${job.id}.`,
          kind: 'task',
          status: 'backlog',
          priority: 'P3',
          source: 'governance_sweep',
          metadata: { sweepJobId: job.id, sweepJobType: job.jobType, auditType: 'reflectionSummary' },
      });
    }

    if (job.jobType === 'self_bootstrap' || job.jobType === 'adversarial_review') {
      const specs = DIMENSION_TODO_SPECS[job.jobType] ?? {};
      const findings = Array.isArray(summary.findings)
        ? summary.findings as Array<{ dimension: string; detail?: string }>
        : [];
      const counts = new Map<string, { count: number; detail: string }>();
      for (const finding of findings) {
        const hit = counts.get(finding.dimension) ?? { count: 0, detail: '' };
        hit.count += 1;
        if (finding.detail) hit.detail = finding.detail;
        counts.set(finding.dimension, hit);
      }
      // Always sync every known dimension so resolved findings archive their
      // todo on the next run (same pattern as reflection/hotspot).
      for (const [dimension, spec] of Object.entries(specs)) {
        const hit = counts.get(dimension);
        created += await syncFindingTodo(todos, job, spec.auditType, hit !== undefined && hit.count > 0, {
            title: spec.title(hit?.count ?? 0, dimension),
            description: spec.description(hit?.count ?? 0, hit?.detail ?? ''),
            kind: 'task',
            status: 'backlog',
            priority: spec.priority,
            source: 'governance_sweep',
            metadata: { sweepJobId: job.id, sweepJobType: job.jobType, auditType: spec.auditType, dimension },
        });
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
