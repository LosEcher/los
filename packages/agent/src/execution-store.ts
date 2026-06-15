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
import { validatePhaseStatusConsistency } from './run-contract.js';
import {
  loadExecutionEntity,
  updateExecutionEntity,
  insertSessionEvent,
  insertExecutionOutbox,
} from './execution-persistence.js';
import { getLogger } from '@los/infra/logger';

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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS execution_outbox (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_spec_id TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_execution_outbox_unpublished ON execution_outbox(created_at, id)
  WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_execution_outbox_session ON execution_outbox(session_id, id);
CREATE INDEX IF NOT EXISTS idx_execution_outbox_run_spec ON execution_outbox(run_spec_id, id);
CREATE INDEX IF NOT EXISTS idx_execution_outbox_entity ON execution_outbox(entity_type, entity_id, id);
`;

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
  await getDb().exec(SCHEMA);
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

      await updateExecutionEntity(client, {
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

      if (input.entityType === 'run_spec' && entity.contract) {
        const drift = validatePhaseStatusConsistency(input.to as string, entity.contract);
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
  await getDb().notify('session_events', JSON.stringify({ sessionId, eventId, type })).catch(() => undefined);
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item;
  }
  return out as T;
}
