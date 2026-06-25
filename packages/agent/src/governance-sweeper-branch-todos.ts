/**
 * Branch-cleanup todo creation — extracted from governance-sweeper.ts to keep
 * that file under the 400-line CI gate. Surfaces non-auto-fixable branch-hygiene
 * findings (non-ff forgejo drift, detached HEAD on a dirty tree, unreachable
 * mirror) as operator-visible todos.
 *
 * Note: `unreachable` is surfaced here as a P2 awareness todo even though it is
 * NOT a finding for the circuit breaker (see `checkHasFindings` in
 * ga-loop-runner.ts). The two are intentionally separate concerns.
 */
import type { GovernanceJob } from './governance-jobs-types.js';
import { createTodo } from './todos.js';

type CreateTodoInput = Parameters<typeof createTodo>[0];

export async function createBranchCleanupTodos(
  job: GovernanceJob,
  summary: Record<string, unknown>,
): Promise<number> {
  let created = 0;
  const drift = typeof summary.forgejoDrift === 'string' ? summary.forgejoDrift : 'none';
  const detached = summary.detached === true;
  const dirty = summary.workingTreeDirty === true;

  const make = async (
    input: Omit<CreateTodoInput, 'kind' | 'status' | 'source' | 'metadata'> & { auditType: string },
  ): Promise<void> => {
    await createTodo({
      title: input.title,
      description: input.description,
      kind: 'task',
      status: 'backlog',
      priority: input.priority,
      source: 'governance_sweep',
      metadata: { sweepJobId: job.id, sweepJobType: job.jobType, auditType: input.auditType },
    });
    created += 1;
  };

  // Non-ff forgejo drift → P1: needs human decision (rebase forgejo onto origin, or reset).
  if (drift === 'non_ff') {
    await make({
      title: 'Governance: forgejo/main diverged from origin/main (non-fast-forward)',
      description: `Branch cleanup: forgejo/main is ahead by ${summary.forgejoAhead ?? '?'} and behind by ${summary.forgejoBehind ?? '?'} — not fast-forwardable. Manual sync required (rebase forgejo onto origin, or reset forgejo main). Review at ${job.id}.`,
      priority: 'P1',
      auditType: 'forgejoNonFf',
    });
  }

  // Detached HEAD on a dirty tree → P1: auto-fix declined to avoid losing work.
  if (detached && dirty) {
    await make({
      title: 'Governance: detached HEAD on dirty working tree — commit or stash, then checkout main',
      description: `Branch cleanup: HEAD is detached and the working tree has uncommitted changes. Auto-fix did not re-attach to avoid losing work. Commit or stash, then run the sweep again. Review at ${job.id}.`,
      priority: 'P1',
      auditType: 'detachedDirty',
    });
  }

  // Forgejo unreachable → P2 informational so the operator notices the mirror is down.
  if (drift === 'unreachable') {
    await make({
      title: 'Governance: forgejo mirror unreachable — branch sync skipped',
      description: `Branch cleanup: could not reach forgejo remote (network/credentials). Forgejo sync was skipped this round; origin-side cleanup still ran. Check LAN connectivity and forgejo credentials. Review at ${job.id}.`,
      priority: 'P2',
      auditType: 'forgejoUnreachable',
    });
  }

  return created;
}
