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
import { validatePhaseStatusConsistency, readRunContractMetadata, type RunContractMetadata } from './run-contract.js';
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
      const entity = await loadExecutionEntity(client, input);
      assertExecutionTransition({
        entityType: input.entityType,
        from: entity.state as ExecutionStateByEntity[T],
        to: input.to,
      });

      await updateExecutionEntity(client, input, entity);
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

      // Cross-validate run_spec.status ↔ run_contract.phase consistency.
      // The two state machines are independent; warn on drift without blocking.
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

type TransactionClient = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

type ExecutionEntityRow = {
  id: string;
  session_id: string;
  run_spec_id: string | null;
  task_run_id: string | null;
  state: string;
  tenant_id: string | null;
  project_id: string | null;
  user_id: string | null;
  node_id: string | null;
  request_id: string | null;
  trace_id: string | null;
  attempt: number | null;
  run_contract_json: unknown | null;
};

type ExecutionEntityContext = {
  id: string;
  sessionId: string;
  runSpecId?: string;
  taskRunId?: string;
  state: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  nodeId?: string;
  requestId?: string;
  traceId?: string;
  attempt?: number;
  contract?: RunContractMetadata;
};

async function loadExecutionEntity<T extends ExecutionEntityType>(
  client: TransactionClient,
  input: TransitionExecutionStateInput<T>,
): Promise<ExecutionEntityContext> {
  switch (input.entityType) {
    case 'run_spec':
      return rowToContext(await loadOne(client, `
        SELECT id, session_id, id AS run_spec_id, NULL::text AS task_run_id, status AS state,
               tenant_id, project_id, user_id, node_id, request_id, trace_id, NULL::integer AS attempt,
               run_contract_json
        FROM run_specs
        WHERE id = $1
        FOR UPDATE
      `, [input.entityId]), input.entityType, input.entityId);
    case 'task_run':
      return rowToContext(await loadOne(client, `
        SELECT id, session_id, run_spec_id, id AS task_run_id, status AS state,
               tenant_id, project_id, user_id, node_id, request_id, trace_id, attempt
        FROM task_runs
        WHERE id = $1
        FOR UPDATE
      `, [input.entityId]), input.entityType, input.entityId);
    case 'tool_call_state':
      if (!input.sessionId) {
        throw new Error('sessionId is required when transitioning tool_call_state');
      }
      return rowToContext(await loadOne(client, `
        SELECT id, session_id, run_spec_id, task_run_id, state,
               NULL::text AS tenant_id, NULL::text AS project_id, NULL::text AS user_id,
               NULL::text AS node_id, NULL::text AS request_id, NULL::text AS trace_id, attempt
        FROM tool_call_states
        WHERE id = $1 AND session_id = $2
        FOR UPDATE
      `, [input.entityId, input.sessionId]), input.entityType, input.entityId);
    case 'verification_record':
      return rowToContext(await loadOne(client, `
        SELECT id, session_id, run_spec_id, task_run_id, status AS state,
               NULL::text AS tenant_id, NULL::text AS project_id, NULL::text AS user_id,
               NULL::text AS node_id, NULL::text AS request_id, NULL::text AS trace_id, NULL::integer AS attempt
        FROM verification_records
        WHERE id = $1
        FOR UPDATE
      `, [input.entityId]), input.entityType, input.entityId);
  }
}

async function updateExecutionEntity<T extends ExecutionEntityType>(
  client: TransactionClient,
  input: TransitionExecutionStateInput<T>,
  entity: ExecutionEntityContext,
): Promise<void> {
  switch (input.entityType) {
    case 'run_spec':
      await client.query(
        'UPDATE run_specs SET status = $2, updated_at = now() WHERE id = $1',
        [input.entityId, input.to],
      );
      return;
    case 'task_run':
      await client.query(`
        UPDATE task_runs
        SET status = $2,
            node_id = COALESCE($3, node_id),
            updated_at = now(),
            started_at = CASE
              WHEN $2 = 'running' AND started_at IS NULL THEN now()
              ELSE started_at
            END,
            completed_at = CASE
              WHEN $2 IN ('succeeded', 'failed', 'cancelled') THEN now()
              ELSE completed_at
            END,
            lease_expires_at = CASE
              WHEN $2 IN ('succeeded', 'failed', 'cancelled') THEN NULL
              ELSE lease_expires_at
            END
        WHERE id = $1
      `, [input.entityId, input.to, input.nodeId ?? entity.nodeId ?? null]);
      return;
    case 'tool_call_state':
      await client.query(`
        UPDATE tool_call_states
        SET state = $3,
            attempt = COALESCE($4, attempt),
            started_at = CASE
              WHEN $3 = 'running' AND started_at IS NULL THEN now()
              ELSE started_at
            END,
            completed_at = CASE
              WHEN $3 IN ('succeeded', 'failed', 'denied', 'skipped') THEN now()
              ELSE completed_at
            END,
            updated_at = now()
        WHERE id = $1 AND session_id = $2
      `, [input.entityId, input.sessionId, input.to, input.attempt ?? null]);
      return;
    case 'verification_record':
      await client.query(`
        UPDATE verification_records
        SET status = $2,
            completed_at = CASE
              WHEN $2 IN ('succeeded', 'failed', 'skipped') THEN now()
              WHEN $2 IN ('required', 'running') THEN NULL
              ELSE completed_at
            END,
            updated_at = now()
        WHERE id = $1
      `, [input.entityId, input.to]);
      return;
  }
}

async function insertSessionEvent(client: TransactionClient, input: {
  sessionId: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  nodeId?: string;
  requestId?: string;
  traceId?: string;
  turn?: number;
  type: string;
  source: string;
  payload: Record<string, unknown>;
}): Promise<SessionEventRecord> {
  const rows = await client.query<SessionEventRow>(`
    INSERT INTO session_events (
      session_id, tenant_id, project_id, user_id, node_id, request_id, trace_id,
      turn, type, source, usage_json, payload_json
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '{}'::jsonb, $11::jsonb)
    RETURNING *
  `, [
    input.sessionId,
    input.tenantId ?? null,
    input.projectId ?? null,
    input.userId ?? null,
    input.nodeId ?? null,
    input.requestId ?? null,
    input.traceId ?? null,
    input.turn ?? 0,
    input.type,
    input.source,
    JSON.stringify(input.payload),
  ]);
  const row = rows.rows[0];
  if (!row) throw new Error('Failed to insert execution session event');
  return rowToSessionEvent(row);
}

async function insertExecutionOutbox(client: TransactionClient, input: {
  sessionId: string;
  runSpecId?: string;
  entityType: ExecutionEntityType;
  entityId: string;
  eventType: string;
  payload: Record<string, unknown>;
}): Promise<number> {
  const rows = await client.query<{ id: string | number }>(`
    INSERT INTO execution_outbox (
      session_id, run_spec_id, entity_type, entity_id, event_type, payload_json
    )
    VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    RETURNING id
  `, [
    input.sessionId,
    input.runSpecId ?? null,
    input.entityType,
    input.entityId,
    input.eventType,
    JSON.stringify(input.payload),
  ]);
  const id = rows.rows[0]?.id;
  if (id === undefined) throw new Error('Failed to insert execution outbox event');
  return Number(id);
}

async function loadOne(
  client: TransactionClient,
  sql: string,
  params: unknown[],
): Promise<ExecutionEntityRow | null> {
  const rows = await client.query<ExecutionEntityRow>(sql, params);
  return rows.rows[0] ?? null;
}

function rowToContext(
  row: ExecutionEntityRow | null,
  entityType: ExecutionEntityType,
  entityId: string,
): ExecutionEntityContext {
  if (!row) throw new Error(`Execution entity not found: ${entityType}:${entityId}`);
  return {
    id: row.id,
    sessionId: row.session_id,
    runSpecId: row.run_spec_id ?? undefined,
    taskRunId: row.task_run_id ?? undefined,
    state: row.state,
    tenantId: row.tenant_id ?? undefined,
    projectId: row.project_id ?? undefined,
    userId: row.user_id ?? undefined,
    nodeId: row.node_id ?? undefined,
    requestId: row.request_id ?? undefined,
    traceId: row.trace_id ?? undefined,
    attempt: row.attempt ?? undefined,
    contract: parseRunContract(row.run_contract_json),
  };
}

type SessionEventRow = {
  id: string | number;
  session_id: string;
  tenant_id: string | null;
  project_id: string | null;
  user_id: string | null;
  node_id: string | null;
  request_id: string | null;
  trace_id: string | null;
  turn: number;
  type: string;
  source: string;
  model: string | null;
  tool_name: string | null;
  cache_key: string | null;
  cache_hit: boolean | null;
  usage_json: unknown;
  parent_event_id: string | number | null;
  visibility: string | null;
  payload_json: unknown;
  created_at: Date | string;
};

function rowToSessionEvent(row: SessionEventRow): SessionEventRecord {
  return {
    id: Number(row.id),
    sessionId: row.session_id,
    tenantId: row.tenant_id ?? undefined,
    projectId: row.project_id ?? undefined,
    userId: row.user_id ?? undefined,
    nodeId: row.node_id ?? undefined,
    requestId: row.request_id ?? undefined,
    traceId: row.trace_id ?? undefined,
    turn: row.turn,
    type: row.type,
    source: row.source,
    model: row.model ?? undefined,
    toolName: row.tool_name ?? undefined,
    cacheKey: row.cache_key ?? undefined,
    cacheHit: row.cache_hit ?? undefined,
    usage: undefined,
    parentEventId: row.parent_event_id === null ? undefined : Number(row.parent_event_id),
    payload: normalizeJsonObject(row.payload_json),
    visibility: (row.visibility as import('./session-events.js').SessionEventVisibility) ?? 'public',
    createdAt: toIsoString(row.created_at),
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

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

function parseRunContract(json: unknown): RunContractMetadata | undefined {
  if (!json) return undefined;
  return readRunContractMetadata({ runContract: json });
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
