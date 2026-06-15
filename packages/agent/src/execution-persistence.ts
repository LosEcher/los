import type { ExecutionEntityType, ExecutionStateByEntity } from './execution-transitions.js';
import type { RunContractMetadata } from './run-contract.js';
import type { SessionEventRecord, SessionEventVisibility } from './session-events.js';
import { readRunContractMetadata } from './run-contract.js';
import { normalizeJsonObject } from './executor-node-utils.js';

export type TransactionClient = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export type ExecutionEntityRow = {
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

export type ExecutionEntityContext = {
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

export async function loadExecutionEntity<T extends ExecutionEntityType>(
  client: TransactionClient,
  input: { entityType: T; entityId: string; sessionId?: string },
): Promise<ExecutionEntityContext> {
  switch (input.entityType) {
    case 'run_spec':
      return rowToContext(await loadOne(client, `
        SELECT id, session_id, id AS run_spec_id, NULL::text AS task_run_id, status AS state,
               tenant_id, project_id, user_id, node_id, request_id, trace_id, NULL::integer AS attempt,
               run_contract_json
        FROM run_specs WHERE id = $1 FOR UPDATE
      `, [input.entityId]), input.entityType, input.entityId);
    case 'task_run':
      return rowToContext(await loadOne(client, `
        SELECT id, session_id, run_spec_id, id AS task_run_id, status AS state,
               tenant_id, project_id, user_id, node_id, request_id, trace_id, attempt
        FROM task_runs WHERE id = $1 FOR UPDATE
      `, [input.entityId]), input.entityType, input.entityId);
    case 'tool_call_state':
      if (!input.sessionId) throw new Error('sessionId is required when transitioning tool_call_state');
      return rowToContext(await loadOne(client, `
        SELECT id, session_id, run_spec_id, task_run_id, state,
               NULL::text AS tenant_id, NULL::text AS project_id, NULL::text AS user_id,
               NULL::text AS node_id, NULL::text AS request_id, NULL::text AS trace_id, attempt
        FROM tool_call_states WHERE id = $1 AND session_id = $2 FOR UPDATE
      `, [input.entityId, input.sessionId]), input.entityType, input.entityId);
    case 'verification_record':
      return rowToContext(await loadOne(client, `
        SELECT id, session_id, run_spec_id, task_run_id, status AS state,
               NULL::text AS tenant_id, NULL::text AS project_id, NULL::text AS user_id,
               NULL::text AS node_id, NULL::text AS request_id, NULL::text AS trace_id, NULL::integer AS attempt
        FROM verification_records WHERE id = $1 FOR UPDATE
      `, [input.entityId]), input.entityType, input.entityId);
    default:
      throw new Error(`Unknown execution entity type: ${input.entityType}`);
  }
}

export async function updateExecutionEntity<T extends ExecutionEntityType>(
  client: TransactionClient,
  input: { entityType: T; entityId: string; to: ExecutionStateByEntity[T]; sessionId?: string; nodeId?: string; attempt?: number },
  entity: ExecutionEntityContext,
): Promise<void> {
  switch (input.entityType) {
    case 'run_spec':
      await client.query('UPDATE run_specs SET status = $2, updated_at = now() WHERE id = $1', [input.entityId, input.to]);
      return;
    case 'task_run':
      await client.query(`
        UPDATE task_runs SET status = $2, node_id = COALESCE($3, node_id), updated_at = now(),
          started_at = CASE WHEN $2 = 'running' AND started_at IS NULL THEN now() ELSE started_at END,
          completed_at = CASE WHEN $2 IN ('succeeded', 'failed', 'cancelled') THEN now() ELSE completed_at END,
          lease_expires_at = CASE WHEN $2 IN ('succeeded', 'failed', 'cancelled') THEN NULL ELSE lease_expires_at END
        WHERE id = $1
      `, [input.entityId, input.to, input.nodeId ?? entity.nodeId ?? null]);
      return;
    case 'tool_call_state':
      await client.query(`
        UPDATE tool_call_states SET state = $3, attempt = COALESCE($4, attempt),
          started_at = CASE WHEN $3 = 'running' AND started_at IS NULL THEN now() ELSE started_at END,
          completed_at = CASE WHEN $3 IN ('succeeded', 'failed', 'denied', 'skipped') THEN now() ELSE completed_at END,
          updated_at = now()
        WHERE id = $1 AND session_id = $2
      `, [input.entityId, input.sessionId, input.to, input.attempt ?? null]);
      return;
    case 'verification_record':
      await client.query(`
        UPDATE verification_records SET status = $2,
          completed_at = CASE WHEN $2 IN ('succeeded', 'failed', 'skipped') THEN now()
                        WHEN $2 IN ('required', 'running') THEN NULL ELSE completed_at END,
          updated_at = now()
        WHERE id = $1
      `, [input.entityId, input.to]);
      return;
    default:
      throw new Error(`Unknown execution entity type: ${input.entityType}`);
  }
}

export async function insertSessionEvent(client: TransactionClient, input: {
  sessionId: string; tenantId?: string; projectId?: string; userId?: string;
  nodeId?: string; requestId?: string; traceId?: string; turn?: number;
  type: string; source: string; payload: Record<string, unknown>;
}): Promise<SessionEventRecord> {
  const rows = await client.query<SessionEventRow>(`
    INSERT INTO session_events (session_id, tenant_id, project_id, user_id, node_id, request_id, trace_id, turn, type, source, usage_json, payload_json)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '{}'::jsonb, $11::jsonb) RETURNING *
  `, [
    input.sessionId, input.tenantId ?? null, input.projectId ?? null, input.userId ?? null,
    input.nodeId ?? null, input.requestId ?? null, input.traceId ?? null, input.turn ?? 0,
    input.type, input.source, JSON.stringify(input.payload),
  ]);
  const row = rows.rows[0];
  if (!row) throw new Error('Failed to insert execution session event');
  return rowToSessionEvent(row);
}

export async function insertExecutionOutbox(client: TransactionClient, input: {
  sessionId: string; runSpecId?: string; entityType: ExecutionEntityType;
  entityId: string; eventType: string; payload: Record<string, unknown>;
}): Promise<number> {
  const rows = await client.query<{ id: string | number }>(`
    INSERT INTO execution_outbox (session_id, run_spec_id, entity_type, entity_id, event_type, payload_json)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id
  `, [input.sessionId, input.runSpecId ?? null, input.entityType, input.entityId, input.eventType, JSON.stringify(input.payload)]);
  const id = rows.rows[0]?.id;
  if (id === undefined) throw new Error('Failed to insert execution outbox event');
  return Number(id);
}

function loadOne(client: TransactionClient, sql: string, params: unknown[]): Promise<ExecutionEntityRow | null> {
  return client.query<ExecutionEntityRow>(sql, params).then(r => r.rows[0] ?? null);
}

function rowToContext(row: ExecutionEntityRow | null, entityType: ExecutionEntityType, entityId: string): ExecutionEntityContext {
  if (!row) throw new Error(`Execution entity not found: ${entityType}:${entityId}`);
  return {
    id: row.id, sessionId: row.session_id, runSpecId: row.run_spec_id ?? undefined,
    taskRunId: row.task_run_id ?? undefined, state: row.state, tenantId: row.tenant_id ?? undefined,
    projectId: row.project_id ?? undefined, userId: row.user_id ?? undefined,
    nodeId: row.node_id ?? undefined, requestId: row.request_id ?? undefined,
    traceId: row.trace_id ?? undefined, attempt: row.attempt ?? undefined,
    contract: parseRunContract(row.run_contract_json),
  };
}

function rowToSessionEvent(row: SessionEventRow): SessionEventRecord {
  return {
    id: Number(row.id), sessionId: row.session_id, tenantId: row.tenant_id ?? undefined,
    projectId: row.project_id ?? undefined, userId: row.user_id ?? undefined,
    nodeId: row.node_id ?? undefined, requestId: row.request_id ?? undefined,
    traceId: row.trace_id ?? undefined, turn: row.turn, type: row.type, source: row.source,
    model: row.model ?? undefined, toolName: row.tool_name ?? undefined,
    cacheKey: row.cache_key ?? undefined, cacheHit: row.cache_hit ?? undefined, usage: undefined,
    parentEventId: row.parent_event_id === null ? undefined : Number(row.parent_event_id),
    payload: normalizeJsonObject(row.payload_json),
    visibility: (row.visibility as SessionEventVisibility) ?? 'public',
    createdAt: toIsoString(row.created_at),
  };
}

function parseRunContract(json: unknown): RunContractMetadata | undefined {
  if (!json) return undefined;
  return readRunContractMetadata({ runContract: json });
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
