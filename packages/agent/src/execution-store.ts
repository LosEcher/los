import { getDb, withDbClient } from '@los/infra/db';
import {
  assertExecutionTransition,
  executionTransitionEventType,
  type ExecutionEntityType,
  type ExecutionStateByEntity,
} from './execution-transitions.js';
import { ensureRunSpecStore } from './run-specs.js';
import { ensureSessionEventStore, type SessionEventRecord } from './session-events.js';
import { ensureTaskRunStore } from './task-runs.js';
import { ensureToolCallStateStore } from './tool-call-states.js';
import { ensureVerificationRecordStore } from './verification-records.js';
import { canMarkSucceeded, canStartExecution, validatePhaseStatusConsistency } from './run-contract.js';
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

export async function transitionExecutionState<T extends ExecutionEntityType>(
  input: TransitionExecutionStateInput<T>,
): Promise<TransitionExecutionStateResult<T>> {
  await ensureExecutionStore();
  const result = await withDbClient(async (client) => {
    await client.query('BEGIN');
    try {
      const entity = await loadExecutionEntity(client, {
        entityType: input.entityType,
        entityId: input.entityId,
        sessionId: input.sessionId,
      });
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
        const verificationRows = await client.query<{ check_name: string; status: string }>(
          `SELECT check_name, status FROM verification_records
           WHERE run_spec_id = $1 AND plan_revision = $2 AND required = TRUE
           FOR UPDATE`,
          [input.entityId, planRevision],
        );
        const successDecision = canMarkSucceeded(
          entity.contract,
          verificationRows.rows.map((row) => ({ requirementId: row.check_name, status: row.status })),
        );
        if (!successDecision.allowed) {
          throw new _RunSuccessGateError(input.entityId, successDecision.reason ?? 'verification gate rejected success');
        }
      }

      const updatedContract = await updateExecutionEntity(client, {
        entityType: input.entityType,
        entityId: input.entityId,
        to: input.to,
        sessionId: input.sessionId,
        nodeId: input.nodeId ?? entity.nodeId,
        attempt: input.attempt ?? entity.attempt,
      }, entity);

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
