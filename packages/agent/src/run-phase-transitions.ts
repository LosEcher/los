import { getDb, withDbClient } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import {
  ensureExecutionOutboxStore,
  insertExecutionOutbox,
  insertSessionEvent,
} from './execution-persistence.js';
import { normalizeRunContractMetadata, validatePhaseTransition, type RunPhase } from './run-contract.js';
import { ensureRunSpecStore } from './run-specs.js';
import { appendSessionEvent, ensureSessionEventStore } from './session-events.js';

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
  // Captured inside the transaction for the same reason as in
  // `transitionExecutionState`: the refusal event is written after the rollback, on
  // its own connection. This path rejects through `validatePhaseTransition` (an
  // error string), not `evaluateExecutionTransition` — the two shapes stay
  // different on purpose; only the audit event type is shared
  // (docs/architecture/2026-10-10-control-plane-truth-remediation.md §8).
  let rejected: { from: RunPhase; to: RunPhase; reason: string; sessionId?: string } | undefined;
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
      if (error) {
        rejected = { from, to: input.to, reason: error, sessionId: row.session_id };
        throw new Error(error);
      }
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
        sessionEventId: event.id,
        payload,
      });
      await client.query('COMMIT');
      return { changed: true, sessionId: row.session_id, eventId: event.id };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }).catch(async (error: unknown) => {
    if (rejected) await recordRejectedPhaseTransition(input, rejected);
    throw error;
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

/**
 * Audit record for a phase transition the phase table refused.
 *
 * Same event type as the execution-state refusal, `entityType: 'run_spec_phase'`.
 * Own connection, after the rollback; failures are logged, never rethrown, so the
 * original refusal still reaches the caller unchanged.
 */
async function recordRejectedPhaseTransition(
  input: TransitionRunSpecPhaseInput,
  rejected: { from: RunPhase; to: RunPhase; reason: string; sessionId?: string },
): Promise<void> {
  if (!rejected.sessionId) {
    getLogger('run-phase-transitions').warn(
      `Rejected phase transition without session: ${input.runSpecId} ${rejected.from}->${rejected.to} (${rejected.reason})`,
    );
    return;
  }
  try {
    await appendSessionEvent({
      sessionId: rejected.sessionId,
      type: 'execution.transition_rejected',
      source: input.source ?? 'los.run-phase',
      payload: {
        entityType: 'run_spec_phase',
        entityId: input.runSpecId,
        from: rejected.from,
        to: rejected.to,
        reason: rejected.reason,
        actor: input.actor ?? null,
      },
    });
  } catch (error) {
    getLogger('run-phase-transitions').warn(
      `Failed to persist rejected phase transition for ${input.runSpecId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function ensureRunSpecVerificationPhase(
  runSpecId: string,
  reason: string,
  source?: string,
): Promise<boolean> {
  return await _transitionRunSpecPhase({ runSpecId, to: 'verifying', reason, source });
}
