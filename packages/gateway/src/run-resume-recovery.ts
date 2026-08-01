import { resolveCoordinationBackend } from '@los/agent/coordination';
import { linkWorkItemRun } from '@los/agent/work-items';
import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import { dispatchPersistedRunSpec } from './run-resume-dispatch.js';

const log = getLogger('run-resume-recovery');
const DEFAULT_RECOVERY_LIMIT = 100;
const RECOVERY_LOCK_KEY = 'approved-run-dispatch-recovery';

export interface ApprovedRunDispatchRecoveryResult {
  lockAcquired: boolean;
  runSpecIds: string[];
}

export interface ApprovedRunDispatchRecoveryOptions {
  limit?: number;
  dispatch?: typeof dispatchPersistedRunSpec;
  onDispatchError?: (runSpecId: string, error: unknown) => void;
}

/**
 * Resume approval dispatches that stopped before a revision-scoped task attempt
 * was persisted. Existing attempts, including terminal ones, are evidence that
 * a separate reconciliation path owns the next action.
 */
export async function recoverApprovedRunDispatches(
  options: ApprovedRunDispatchRecoveryOptions = {},
): Promise<ApprovedRunDispatchRecoveryResult> {
  const backend = await resolveCoordinationBackend();
  const result = await backend.lock.withLock(RECOVERY_LOCK_KEY, async () => {
    const runSpecIds = await listApprovedRunsWithoutExecutionAttempt(options.limit);
    const dispatch = options.dispatch ?? dispatchPersistedRunSpec;
    for (const runSpecId of runSpecIds) {
      // Record the crash-recovery lineage on the owning work item (best-effort).
      await linkRecoveredRunToWorkItem(runSpecId).catch((error: unknown) => {
        log.warn('work item recovery lineage failed', {
          runSpecId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      void dispatch(runSpecId, 'execution').catch((error: unknown) => {
        if (options.onDispatchError) {
          options.onDispatchError(runSpecId, error);
          return;
        }
        log.warn('approved run recovery dispatch failed', {
          runSpecId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return runSpecIds;
  });

  if (result === null) return { lockAcquired: false, runSpecIds: [] };
  return { lockAcquired: true, runSpecIds: result };
}

async function listApprovedRunsWithoutExecutionAttempt(limit = DEFAULT_RECOVERY_LIMIT): Promise<string[]> {  const boundedLimit = Number.isInteger(limit) && limit > 0
    ? Math.min(limit, 1_000)
    : DEFAULT_RECOVERY_LIMIT;
  const rows = await getDb().query<{ id: string }>(
    `
    SELECT run_spec.id
    FROM run_specs AS run_spec
    WHERE (
      (run_spec.status = 'created' AND run_spec.run_contract_json->>'phase' = 'plan_approved')
      OR
      (run_spec.status = 'running' AND run_spec.run_contract_json->>'phase' = 'executing')
    )
      AND NOT EXISTS (
        SELECT 1
        FROM task_runs AS task_run
        WHERE task_run.dedupe_key = (
          'run:' || run_spec.id || ':execution:' ||
          COALESCE(NULLIF(run_spec.run_contract_json->>'planRevision', ''), '1')
        )
      )
    ORDER BY run_spec.updated_at ASC, run_spec.id ASC
    LIMIT $1
    `,
    [boundedLimit],
  );
  return rows.rows.map((row) => row.id);
}

/**
 * Re-tag the owning work item's link for a recovered run with
 * relationKind='recovery' (upsert; the run spec already has a planning or
 * execution link). No-op when no work item owns the run spec. Best-effort:
 * callers catch errors so a missing work-item store never blocks recovery.
 */
async function linkRecoveredRunToWorkItem(runSpecId: string): Promise<void> {
  const rows = await getDb().query<{ work_item_id: string }>(
    'SELECT work_item_id FROM work_item_runs WHERE run_spec_id = $1 LIMIT 1',
    [runSpecId],
  );
  const workItemId = rows.rows[0]?.work_item_id;
  if (!workItemId) return;
  await linkWorkItemRun({ workItemId, runSpecId, relationKind: 'recovery' });
}
