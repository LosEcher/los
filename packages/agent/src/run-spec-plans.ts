import { getDb, withDbClient } from '@los/infra/db';
import {
  ensureExecutionOutboxStore,
  insertExecutionOutbox,
  insertSessionEvent,
} from './execution-persistence.js';
import {
  normalizePlanForPersistence,
  validatePlanForApproval,
  validateVerificationExecutionSupport,
  validateVerificationMappingForApproval,
} from './run-plan-validation.js';
import { normalizeRunContractMetadata, type PlanStep, type VerificationRequirement } from './run-contract.js';
import { ensureRunSpecStore, loadRunSpec, type RunSpecRecord } from './run-specs.js';
import { ensureSessionEventStore } from './session-events.js';
import {
  ensureVerificationRecordStore,
  replaceVerificationRequirementsForRunSpec,
} from './verification-records.js';

type RunSpecPlanRow = {
  id: string;
  session_id: string;
  tenant_id: string | null;
  project_id: string | null;
  user_id: string | null;
  node_id: string | null;
  request_id: string | null;
  trace_id: string | null;
  run_contract_json: unknown;
};

export async function persistRunSpecPlan(
  id: string,
  input: { plan: PlanStep[]; verifications?: VerificationRequirement[]; actor?: string; summary?: string },
): Promise<RunSpecRecord> {
  const planError = validatePlanForApproval(input.plan);
  if (planError) throw new Error(planError);
  await Promise.all([
    ensureRunSpecStore(),
    ensureSessionEventStore(),
    ensureExecutionOutboxStore(),
    ensureVerificationRecordStore(),
  ]);
  const result = await withDbClient(async (client) => {
    await client.query('BEGIN');
    try {
      const rows = await client.query<RunSpecPlanRow>('SELECT * FROM run_specs WHERE id = $1 FOR UPDATE', [id]);
      const row = rows.rows[0];
      if (!row) throw new Error(`Run spec not found: ${id}`);
      const current = normalizeRunContractMetadata(row.run_contract_json);
      if (current?.phase !== 'planning') {
        throw new Error(`Planning output requires run phase 'planning', received '${current?.phase ?? 'created'}'`);
      }
      const plan = normalizePlanForPersistence(input.plan);
      const verifications = input.verifications ?? [];
      const nextContract = {
        ...current,
        plan,
        verifications,
        planRevision: current.planRevision ?? 1,
      };
      const mappingError = validateVerificationMappingForApproval(nextContract);
      if (mappingError) throw new Error(mappingError);
      const supportError = validateVerificationExecutionSupport(nextContract);
      if (supportError) throw new Error(supportError);
      await client.query(
        'UPDATE run_specs SET run_contract_json = run_contract_json || $2::jsonb, updated_at = now() WHERE id = $1',
        [id, JSON.stringify({ plan, verifications, planRevision: nextContract.planRevision })],
      );
      await client.query(
        "DELETE FROM verification_records WHERE run_spec_id = $1 AND plan_revision = $2 AND status = 'required'",
        [id, nextContract.planRevision],
      );
      await replaceVerificationRequirementsForRunSpec(client, {
        runSpecId: id,
        sessionId: row.session_id,
        planRevision: nextContract.planRevision,
        requiredChecks: nextContract.requiredChecks,
        verifications,
      });
      const payload = {
        runSpecId: id,
        phase: 'planning',
        planRevision: nextContract.planRevision,
        planStepCount: plan.length,
        verificationCount: verifications.length,
        actor: input.actor ?? null,
        summary: input.summary ?? null,
        producedAt: new Date().toISOString(),
      };
      const event = await insertSessionEvent(client, {
        sessionId: row.session_id,
        tenantId: row.tenant_id ?? undefined,
        projectId: row.project_id ?? undefined,
        userId: row.user_id ?? undefined,
        nodeId: row.node_id ?? undefined,
        requestId: row.request_id ?? undefined,
        traceId: row.trace_id ?? undefined,
        type: 'run.plan_produced',
        source: 'los.planner',
        payload,
      });
      await insertExecutionOutbox(client, {
        sessionId: row.session_id,
        runSpecId: id,
        entityType: 'run_spec',
        entityId: id,
        eventType: 'run.plan_produced',
        sessionEventId: event.id,
        payload,
      });
      await client.query('COMMIT');
      return { sessionId: row.session_id, eventId: event.id };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
  await getDb().notify('session_events', JSON.stringify({
    session_id: result.sessionId,
    event_id: result.eventId,
    type: 'run.plan_produced',
  })).catch(() => undefined);
  const record = await loadRunSpec(id);
  if (!record) throw new Error(`Run spec disappeared after planning output persistence: ${id}`);
  return record;
}
