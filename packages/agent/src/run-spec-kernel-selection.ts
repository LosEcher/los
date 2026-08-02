import { getDb, withDbClient } from '@los/infra/db';
import { isDeepStrictEqual } from 'node:util';
import {
  applyK4ExecutionKernelRollback,
  executionKernelIdentitiesEqual,
  getLosKernelSelectionIdentity,
  getPiK4KernelSelectionIdentity,
  grantK4CanaryAuthorization,
  normalizeExecutionKernelSelection,
  type ExecutionKernelSelection,
} from './execution-kernel-selection.js';
import { ensureExecutionOutboxStore, insertExecutionOutbox, insertSessionEvent } from './execution-persistence.js';
import { normalizeRunContractMetadata } from './run-contract.js';
import { ensureSessionEventStore } from './session-events.js';

export async function authorizeRunSpecKernelCanary(input: {
  runSpecId: string;
  experimentId: string;
  actor: string;
}): Promise<ExecutionKernelSelection> {
  return await mutateSelection({
    ...input,
    eventType: 'run.kernel_canary_authorized',
    reason: 'operator_authorized_pi_k4_canary',
    requireApprovedExperiment: true,
    mutate(selection, row) {
      assertMutableCandidate(row, ['planning', 'plan_approved']);
      if (selection.canaryAuthorization.status === 'granted') return selection;
      return grantK4CanaryAuthorization(selection, input.actor);
    },
  });
}

export async function rollbackRunSpecExecutionKernel(input: {
  runSpecId: string;
  experimentId: string;
  actor: string;
  reason?: string;
}): Promise<ExecutionKernelSelection> {
  return await mutateSelection({
    ...input,
    eventType: 'run.kernel_rollback_applied',
    reason: input.reason ?? 'operator_rolled_back_pi_k4_candidate',
    mutate(selection, row) {
      assertMutableCandidate(row, ['planning', 'plan_approved', 'blocked'], ['created', 'blocked']);
      if (selection.rollback.status === 'applied') return selection;
      return applyK4ExecutionKernelRollback(selection, input.actor, input.reason);
    },
  });
}

export async function assertPersistedRunSpecKernelSelection(input: {
  runSpecId: string;
  selection: ExecutionKernelSelection;
  tenantId?: string;
  projectId?: string;
}): Promise<void> {
  const rows = await getDb().query<PersistedSelectionRow>(
    `SELECT rs.session_id, rs.tenant_id, rs.project_id, rs.run_contract_json,
            ee.status AS experiment_status, ee.candidate_run_spec_id
     FROM run_specs rs
     LEFT JOIN execution_experiments ee ON ee.id = $2
     WHERE rs.id = $1`,
    [input.runSpecId, input.selection.experimentId],
  );
  const row = rows.rows[0];
  if (!row) throw new Error(`Run spec not found: ${input.runSpecId}`);
  const persisted = normalizeExecutionKernelSelection(
    normalizeRunContractMetadata(row.run_contract_json)?.executionKernel,
  );
  if (!persisted || !isDeepStrictEqual(persisted, input.selection)) {
    throw new Error('Persisted execution-kernel selection does not match the scheduled run contract');
  }
  if (row.candidate_run_spec_id !== input.runSpecId) throw new Error('Execution experiment is not linked to the candidate run spec');
  if ((input.tenantId !== undefined && row.tenant_id !== input.tenantId)
    || (input.projectId !== undefined && row.project_id !== input.projectId)) {
    throw new Error('Execution-kernel selection scope does not match the scheduled run');
  }
  if (executionKernelIdentitiesEqual(persisted.selected, getPiK4KernelSelectionIdentity())) {
    // The experiment transitions to 'running' inside the execute endpoint before
    // dispatch, so both approved and running are legal pre-dispatch states.
    if (row.experiment_status !== 'approved' && row.experiment_status !== 'running') {
      throw new Error('Pi K4 execution experiment is not approved');
    }
    await assertSelectionEvent(row.session_id, input.runSpecId, persisted.experimentId, 'run.kernel_canary_authorized');
  } else if (executionKernelIdentitiesEqual(persisted.selected, getLosKernelSelectionIdentity())) {
    await assertSelectionEvent(row.session_id, input.runSpecId, persisted.experimentId, 'run.kernel_rollback_applied');
  }
}

async function mutateSelection(input: {
  runSpecId: string;
  experimentId: string;
  actor: string;
  eventType: string;
  reason: string;
  mutate(selection: ExecutionKernelSelection, row: RunSpecKernelRow): ExecutionKernelSelection;
  requireApprovedExperiment?: boolean;
}): Promise<ExecutionKernelSelection> {
  await Promise.all([ensureSessionEventStore(), ensureExecutionOutboxStore()]);
  const result = await withDbClient(async client => {
    await client.query('BEGIN');
    try {
      const rows = await client.query<RunSpecKernelRow>(
        `SELECT id, session_id, tenant_id, project_id, user_id, node_id, request_id, trace_id,
                status, run_contract_json
         FROM run_specs WHERE id = $1 FOR UPDATE`,
        [input.runSpecId],
      );
      const row = rows.rows[0];
      if (!row) throw new Error(`Run spec not found: ${input.runSpecId}`);
      const experimentRows = await client.query<{ status: string; candidate_run_spec_id: string | null; tenant_id: string | null; project_id: string | null }>(
        `SELECT status, candidate_run_spec_id, tenant_id, project_id
         FROM execution_experiments WHERE id = $1 FOR UPDATE`,
        [input.experimentId],
      );
      const experiment = experimentRows.rows[0];
      if (!experiment || experiment.candidate_run_spec_id !== input.runSpecId) {
        throw new Error(`Execution experiment ${input.experimentId} is not linked to run spec ${input.runSpecId}`);
      }
      if (experiment.tenant_id !== row.tenant_id || experiment.project_id !== row.project_id) {
        throw new Error('Execution experiment scope does not match candidate run spec scope');
      }
      if (input.requireApprovedExperiment && experiment.status !== 'approved') {
        throw new Error(`Canary authorization requires approved execution experiment (status=${experiment.status})`);
      }
      const contract = normalizeRunContractMetadata(row.run_contract_json);
      const current = normalizeExecutionKernelSelection(contract?.executionKernel);
      if (!current) throw new Error(`Run spec ${input.runSpecId} has no explicit execution-kernel selection`);
      if (current.experimentId !== input.experimentId) {
        throw new Error(`Run spec ${input.runSpecId} belongs to execution experiment ${current.experimentId}`);
      }
      const updated = input.mutate(current, row);
      if (JSON.stringify(updated) === JSON.stringify(current)) {
        await client.query('COMMIT');
        return { selection: current, eventId: undefined, sessionId: row.session_id };
      }
      await client.query(
        `UPDATE run_specs
         SET run_contract_json = jsonb_set(run_contract_json, '{executionKernel}', $2::jsonb, true),
             updated_at = now()
         WHERE id = $1`,
        [input.runSpecId, JSON.stringify(updated)],
      );
      const event = await insertSessionEvent(client, {
        sessionId: row.session_id,
        tenantId: row.tenant_id ?? undefined,
        projectId: row.project_id ?? undefined,
        userId: row.user_id ?? undefined,
        nodeId: row.node_id ?? undefined,
        requestId: row.request_id ?? undefined,
        traceId: row.trace_id ?? undefined,
        type: input.eventType,
        source: 'operator',
        payload: {
          runSpecId: input.runSpecId,
          experimentId: input.experimentId,
          actor: input.actor,
          reason: input.reason,
          requested: updated.requested,
          selected: updated.selected,
          rollback: updated.rollback,
          canaryAuthorization: updated.canaryAuthorization,
        },
      });
      await insertExecutionOutbox(client, {
        sessionId: row.session_id,
        runSpecId: input.runSpecId,
        entityType: 'run_spec',
        entityId: input.runSpecId,
        eventType: input.eventType,
        sessionEventId: event.id,
        payload: event.payload ?? {},
      });
      await client.query('COMMIT');
      return { selection: updated, eventId: event.id, sessionId: row.session_id };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
  if (result.eventId !== undefined) {
    await getDb().notify('session_events', JSON.stringify({
      session_id: result.sessionId,
      event_id: result.eventId,
      type: input.eventType,
    })).catch(() => undefined);
  }
  return result.selection;
}

async function assertSelectionEvent(
  sessionId: string,
  runSpecId: string,
  experimentId: string,
  eventType: string,
): Promise<void> {
  const events = await getDb().query<{ id: number }>(
    `SELECT id FROM session_events
     WHERE session_id = $1 AND type = $2
       AND payload_json->>'runSpecId' = $3
       AND payload_json->>'experimentId' = $4
     ORDER BY id DESC LIMIT 1`,
    [sessionId, eventType, runSpecId, experimentId],
  );
  if (!events.rows[0]) throw new Error(`Persisted execution-kernel evidence is missing: ${eventType}`);
}

function assertMutableCandidate(
  row: RunSpecKernelRow,
  allowedPhases: string[],
  allowedStatuses = ['created'],
): void {
  const contract = normalizeRunContractMetadata(row.run_contract_json);
  if (!allowedStatuses.includes(row.status)) {
    throw new Error(`Run spec kernel selection is immutable while status=${row.status}`);
  }
  const phase = contract?.phase ?? 'created';
  if (!allowedPhases.includes(phase)) {
    throw new Error(`Run spec kernel selection is immutable while phase=${phase}`);
  }
}

type RunSpecKernelRow = {
  id: string;
  session_id: string;
  tenant_id: string | null;
  project_id: string | null;
  user_id: string | null;
  node_id: string | null;
  request_id: string | null;
  trace_id: string | null;
  status: string;
  run_contract_json: unknown;
};

type PersistedSelectionRow = {
  session_id: string;
  tenant_id: string | null;
  project_id: string | null;
  run_contract_json: unknown;
  experiment_status: string | null;
  candidate_run_spec_id: string | null;
};
