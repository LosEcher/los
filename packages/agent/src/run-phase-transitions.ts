import { getDb, withDbClient } from '@los/infra/db';
import {
  ensureExecutionOutboxStore,
  insertExecutionOutbox,
  insertSessionEvent,
} from './execution-persistence.js';
import { normalizeRunContractMetadata, validatePhaseTransition, type RunPhase } from './run-contract.js';
import { ensureRunSpecStore } from './run-specs.js';
import { ensureSessionEventStore } from './session-events.js';

type RunPhaseRow = {
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

interface TransitionRunSpecPhaseInput {
  runSpecId: string;
  to: RunPhase;
  reason: string;
  source?: string;
  actor?: string;
}

async function _transitionRunSpecPhase(input: TransitionRunSpecPhaseInput): Promise<boolean> {
  await Promise.all([ensureRunSpecStore(), ensureSessionEventStore(), ensureExecutionOutboxStore()]);
  const result = await withDbClient(async (client) => {
    await client.query('BEGIN');
    try {
      const rows = await client.query<RunPhaseRow>('SELECT * FROM run_specs WHERE id = $1 FOR UPDATE', [input.runSpecId]);
      const row = rows.rows[0];
      if (!row) throw new Error(`Run spec not found: ${input.runSpecId}`);
      const contract = normalizeRunContractMetadata(row.run_contract_json);
      const from = contract?.phase;
      if (!from || from === input.to) {
        await client.query('COMMIT');
        return { changed: false, sessionId: row.session_id, eventId: undefined };
      }
      const error = validatePhaseTransition(from, input.to);
      if (error) throw new Error(error);
      const changedAt = new Date().toISOString();
      const patch = { phase: input.to, previousPhase: from, phaseChangedAt: changedAt };
      await client.query(
        'UPDATE run_specs SET run_contract_json = run_contract_json || $2::jsonb, updated_at = now() WHERE id = $1',
        [input.runSpecId, JSON.stringify(patch)],
      );
      const payload = {
        runSpecId: input.runSpecId,
        previousPhase: from ?? null,
        phase: input.to,
        reason: input.reason,
        actor: input.actor ?? null,
        changedAt,
      };
      const eventType = `run.phase.${input.to}`;
      const event = await insertSessionEvent(client, {
        sessionId: row.session_id,
        tenantId: row.tenant_id ?? undefined,
        projectId: row.project_id ?? undefined,
        userId: row.user_id ?? undefined,
        nodeId: row.node_id ?? undefined,
        requestId: row.request_id ?? undefined,
        traceId: row.trace_id ?? undefined,
        type: eventType,
        source: input.source ?? 'los.run-phase',
        payload,
      });
      await insertExecutionOutbox(client, {
        sessionId: row.session_id,
        runSpecId: input.runSpecId,
        entityType: 'run_spec',
        entityId: input.runSpecId,
        eventType,
        payload,
      });
      await client.query('COMMIT');
      return { changed: true, sessionId: row.session_id, eventId: event.id };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
  if (result.eventId !== undefined) {
    await getDb().notify('session_events', JSON.stringify({
      session_id: result.sessionId,
      event_id: result.eventId,
      type: `run.phase.${input.to}`,
    })).catch(() => undefined);
  }
  return result.changed;
}

export async function ensureRunSpecVerificationPhase(
  runSpecId: string,
  reason: string,
  source?: string,
): Promise<boolean> {
  return await _transitionRunSpecPhase({ runSpecId, to: 'verifying', reason, source });
}
