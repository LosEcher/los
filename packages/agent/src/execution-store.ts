import { getDb, withDbClient } from '@los/infra/db';
import {
  assertExecutionTransition,
  evaluateExecutionTransition,
  executionTransitionEventType,
  type ExecutionEntityType,
  type ExecutionStateByEntity,
} from './execution-transitions.js';
import { ensureRunSpecStore } from './run-specs.js';
import { appendSessionEvent, ensureSessionEventStore, type SessionEventRecord } from './session-events.js';
import { ensureTaskRunStore } from './task-runs.js';
import { ensureToolCallStateStore } from './tool-call-states.js';
import { ensureVerificationRecordStore } from './verification-records.js';
import { canMarkSucceeded, canStartExecution, readRunContractMetadata, validatePhaseStatusConsistency } from './run-contract.js';
import {
  loadExecutionEntity,
  updateExecutionEntity,
  insertSessionEvent,
  insertExecutionOutbox,
  ensureExecutionOutboxStore,
} from './execution-persistence.js';
import { getLogger } from '@los/infra/logger';
import { eventBus } from './event-bus.js';

const log = getLogger('execution-store');

export interface ExecutionEventEnvelope<T extends ExecutionEntityType = ExecutionEntityType> {
  entityType: T;
  entityId: string;
  from: ExecutionStateByEntity[T];
  to: ExecutionStateByEntity[T];
  reason: string;
  commandId?: string;
  causationId?: string;
  correlationId?: string;
  nodeId?: string;
  attempt?: number;
  leaseVersion?: number;
  leaseCondition?: 'active' | 'expired';
}

export interface TransitionExecutionStateInput<T extends ExecutionEntityType = ExecutionEntityType> {
  entityType: T;
  entityId: string;
  to: ExecutionStateByEntity[T];
  sessionId?: string;
  reason: string;
  commandId?: string;
  causationId?: string;
  correlationId?: string;
  nodeId?: string;
  attempt?: number;
  leaseVersion?: number;
  leaseCondition?: 'active' | 'expired';
  eventType?: string;
  source?: string;
  turn?: number;
}

export interface TransitionExecutionStateResult<T extends ExecutionEntityType = ExecutionEntityType> {
  entityType: T;
  entityId: string;
  sessionId: string;
  runSpecId?: string;
  taskRunId?: string;
  from: ExecutionStateByEntity[T];
  to: ExecutionStateByEntity[T];
  event: SessionEventRecord;
  outboxId: number;
}

export class _RunSuccessGateError extends Error {
  constructor(runSpecId: string, reason: string) {
    super(`Run spec ${runSpecId} cannot be marked succeeded: ${reason}`);
    this.name = 'RunSuccessGateError';
  }
}

export class _LeaseLostError extends Error {
  constructor(entityType: string, entityId: string) {
    super(`${entityType} ${entityId} lease lost`);
    this.name = 'LeaseLostError';
  }
}

let _initialized = false;

export async function ensureExecutionStore(): Promise<void> {
  if (_initialized) return;
  await Promise.all([
    ensureRunSpecStore(),
    ensureTaskRunStore(),
    ensureToolCallStateStore(),
    ensureVerificationRecordStore(),
    ensureSessionEventStore(),
  ]);
  await ensureExecutionOutboxStore();
  _initialized = true;
}

/**
 * Write the audit record for a transition the state machine refused.
 *
 * Runs on its **own** connection, after the refused transition's transaction has
 * rolled back. Failures here are logged and swallowed: they must never replace or
 * hide the original `ExecutionTransitionError`, and they must never re-open the
 * rolled-back work.
 *
 * Deliberately does **not** insert an `execution_outbox` row. The outbox delivers
 * successful state changes; routing refusals through it would couple this audit to
 * the delivery cap and turn a rejected transition into a second retry queue.
 */
async function recordRejectedTransition(input: {
  entityType: ExecutionEntityType;
  entityId: string;
  from: string;
  to: string;
  reason: string;
  sessionId?: string;
  actor?: string;
}): Promise<void> {
  if (!input.sessionId) {
    // No session means the entity could not be loaded (or the entity type has no
    // session). Synthesising a `dlq-*` session belongs to writeDeadLetterEvent, not
    // here; a refusal with nowhere to land is logged and counted instead.
    log.warn(
      `Rejected transition without session: ${input.entityType}:${input.entityId} ${input.from}->${input.to} (${input.reason})`,
    );
    return;
  }
  try {
    await appendSessionEvent({
      sessionId: input.sessionId,
      type: 'execution.transition_rejected',
      source: 'los.execution-state',
      payload: {
        entityType: input.entityType,
        entityId: input.entityId,
        from: input.from,
        to: input.to,
        reason: input.reason,
        actor: input.actor ?? null,
      },
    });
  } catch (error) {
    log.warn(
      `Failed to persist rejected transition for ${input.entityType}:${input.entityId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function transitionExecutionState<T extends ExecutionEntityType>(
  input: TransitionExecutionStateInput<T>,
): Promise<TransitionExecutionStateResult<T>> {
  await ensureExecutionStore();
  // Filled inside the transaction and consumed after it rolls back: the refusal
  // must be durable, but it must not be written on the transaction that is about
  // to be discarded (truth remediation §8).
  let rejected: { from: string; to: string; reason: string; sessionId?: string } | undefined;
  type TransitionOutcome = {
    entity: Awaited<ReturnType<typeof loadExecutionEntity>>;
    event: SessionEventRecord;
    outboxId: number;
    from: ExecutionStateByEntity[T];
  };
  let result: TransitionOutcome;
  try {
    result = await withDbClient(async (client) => {
      await client.query('BEGIN');
    try {
      const entity = await loadExecutionEntity(client, {
        entityType: input.entityType,
        entityId: input.entityId,
        sessionId: input.sessionId,
      });
      // Evaluate before asserting so the reason string is available for the audit
      // event. Same loaded-and-locked state, same predicates — the assertion below
      // still throws the original error type.
      const evaluation = evaluateExecutionTransition({
        entityType: input.entityType,
        from: entity.state as ExecutionStateByEntity[T],
        to: input.to,
      });
      if (!evaluation.allowed) {
        rejected = {
          from: String(entity.state),
          to: String(input.to),
          reason: evaluation.reason,
          sessionId: entity.sessionId,
        };
      }
      assertExecutionTransition({
        entityType: input.entityType,
        from: entity.state as ExecutionStateByEntity[T],
        to: input.to,
      });

      if (input.entityType === 'run_spec' && input.to === 'running' && entity.state !== 'blocked' && entity.contract?.phase) {
        const startDecision = canStartExecution(entity.contract);
        if (!startDecision.allowed) {
          throw new Error(`Run spec ${input.entityId} cannot start: ${startDecision.reason}`);
        }
      }
      if (input.entityType === 'run_spec' && input.to === 'succeeded') {
        if (entity.contract?.phase && entity.contract.phase !== 'verifying') {
          throw new _RunSuccessGateError(input.entityId, `phase '${entity.contract.phase}' must transition to 'verifying' first`);
        }
        const planRevision = entity.contract?.planRevision ?? 1;
        const verificationRows = await client.query<{ check_name: string; command: string | null; status: string }>(
          `SELECT check_name, command, status FROM verification_records
           WHERE run_spec_id = $1 AND plan_revision = $2 AND required = TRUE
           FOR UPDATE`,
          [input.entityId, planRevision],
        );
        // Match both the record's check_name (verification id) and its command
        // text (requiredChecks are keyed by full command in the contract).
        const successDecision = canMarkSucceeded(
          entity.contract,
          verificationRows.rows.flatMap((row) => [
            { requirementId: row.check_name, status: row.status },
            ...(row.command ? [{ requirementId: row.command, status: row.status }] : []),
          ]),
        );
        if (!successDecision.allowed) {
          throw new _RunSuccessGateError(input.entityId, successDecision.reason ?? 'verification gate rejected success');
        }
      }
      if (input.entityType === 'execution_experiment' && input.to === 'succeeded') {
        if (!entity.candidateRunSpecId) throw new Error(`Experiment ${input.entityId} has no candidate run spec`);
        const candidate = await client.query<{ status: string; run_contract_json: unknown }>(
          `SELECT status, run_contract_json FROM run_specs WHERE id = $1 FOR UPDATE`, [entity.candidateRunSpecId],
        );
        const candidateRow = candidate.rows[0];
        if (!candidateRow || candidateRow.status !== 'succeeded') {
          throw new _RunSuccessGateError(input.entityId, 'candidate run spec is not succeeded');
        }
        const required = await client.query<{ check_name: string; status: string }>(
          `SELECT check_name, status FROM verification_records WHERE run_spec_id = $1 AND required = TRUE`,
          [entity.candidateRunSpecId],
        );
        const contract = readRunContractMetadata({ runContract: candidateRow.run_contract_json });
        const successDecision = canMarkSucceeded(contract, required.rows.map(row => ({ requirementId: row.check_name, status: row.status })));
        if (!successDecision.allowed) throw new _RunSuccessGateError(input.entityId, successDecision.reason ?? 'candidate verification gate rejected success');
      }

      if (input.leaseVersion !== undefined && !input.nodeId) {
        throw new Error('nodeId is required when leaseVersion is provided');
      }
      const persistence = await updateExecutionEntity(client, {
        entityType: input.entityType,
        entityId: input.entityId,
        to: input.to,
        sessionId: input.sessionId,
        nodeId: input.nodeId ?? entity.nodeId,
        attempt: input.attempt ?? entity.attempt,
        leaseVersion: input.leaseVersion,
        leaseCondition: input.leaseCondition,
      }, entity);
      if (!persistence.updated) throw new _LeaseLostError(input.entityType, input.entityId);
      const updatedContract = persistence.contract;

      const envelope = stripUndefined({
        entityType: input.entityType,
        entityId: input.entityId,
        from: entity.state as ExecutionStateByEntity[T],
        to: input.to,
        reason: input.reason,
        commandId: input.commandId,
        causationId: input.causationId,
        correlationId: input.correlationId ?? entity.traceId,
        nodeId: input.nodeId ?? entity.nodeId,
        attempt: input.attempt ?? entity.attempt,
        leaseVersion: input.leaseVersion,
        leaseCondition: input.leaseCondition,
      }) as Record<string, unknown> & ExecutionEventEnvelope<T>;
      const eventType = input.eventType ?? executionTransitionEventType(input.entityType, input.to);
      const event = await insertSessionEvent(client, {
        sessionId: entity.sessionId,
        tenantId: entity.tenantId,
        projectId: entity.projectId,
        userId: entity.userId,
        nodeId: input.nodeId ?? entity.nodeId,
        requestId: entity.requestId,
        traceId: input.correlationId ?? entity.traceId,
        turn: input.turn,
        type: eventType,
        source: input.source ?? 'los.execution',
        payload: envelope,
      });
      const outboxId = await insertExecutionOutbox(client, {
        sessionId: entity.sessionId,
        runSpecId: entity.runSpecId,
        entityType: input.entityType,
        entityId: input.entityId,
        eventType,
        sessionEventId: event.id,
        payload: envelope,
      });

      await client.query('COMMIT');

      if (input.entityType === 'run_spec' && updatedContract) {
        const drift = validatePhaseStatusConsistency(input.to as string, updatedContract);
        if (drift) {
          log.warn(`Phase/status drift on run_spec ${input.entityId}: ${drift}`);
        }
      }

      return {
        entity,
        event,
        outboxId,
        from: entity.state as ExecutionStateByEntity[T],
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
    });
  } catch (error) {
    if (rejected) {
      // The refusal is durable; the thrown error is unchanged.
      await recordRejectedTransition({
        entityType: input.entityType,
        entityId: input.entityId,
        from: rejected.from,
        to: rejected.to,
        reason: rejected.reason,
        sessionId: rejected.sessionId,
        actor: input.source,
      });
    }
    throw error;
  }

  await notifySessionEvent(result.entity.sessionId, result.event.id, result.event.type);

  // Emit on in-process event bus so consumers (SSE, scheduler, etc.) don't
  // need to poll execution_outbox. Cross-gateway push stays on PG NOTIFY.
  eventBus.emit('execution:transition', {
    entityType: input.entityType,
    entityId: input.entityId,
    sessionId: result.entity.sessionId,
    from: String(result.from),
    to: String(input.to),
    reason: input.reason,
    eventId: result.event.id,
    outboxId: result.outboxId,
    runSpecId: result.entity.runSpecId,
    taskRunId: result.entity.taskRunId,
    commandId: input.commandId,
    causationId: input.causationId,
    correlationId: input.correlationId ?? result.entity.traceId,
    nodeId: input.nodeId ?? result.entity.nodeId,
    attempt: input.attempt ?? result.entity.attempt,
  });

  // Phase 2 fleet quality: project a single run_eval after terminal run_spec
  // transitions. Best-effort only — never blocks or rolls back the transition.
  if (input.entityType === 'run_spec') {
    const terminal = input.to === 'succeeded'
      || input.to === 'failed'
      || input.to === 'blocked'
      || input.to === 'cancelled';
    if (terminal) {
      void import('./run-evals/terminal-projection.js').then(({ scheduleTerminalRunEval }) => {
        scheduleTerminalRunEval({
          runSpecId: input.entityId,
          sessionId: result.entity.sessionId,
          taskRunId: result.entity.taskRunId,
          status: String(input.to),
          reason: input.reason,
        });
      }).catch(() => undefined);
    }
  }

  return {
    entityType: input.entityType,
    entityId: input.entityId,
    sessionId: result.entity.sessionId,
    runSpecId: result.entity.runSpecId,
    taskRunId: result.entity.taskRunId,
    from: result.from,
    to: input.to,
    event: result.event,
    outboxId: result.outboxId,
  };
}

async function notifySessionEvent(sessionId: string, eventId: number, type: string): Promise<void> {
  await getDb().notify('session_events', JSON.stringify({ session_id: sessionId, event_id: eventId, type })).catch(() => undefined);
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item;
  }
  return out as T;
}
