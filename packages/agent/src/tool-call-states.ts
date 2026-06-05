/**
 * @los/agent/tool-call-states — Durable tool call state machine.
 *
 * Each tool invocation gets a row tracking its lifecycle:
 *   requested → approved|denied → running → succeeded|failed|retrying
 *
 * Linked to run_spec, task_run, and session for full audit trail.
 */

import { getDb } from '@los/infra/db';

// ── Types ───────────────────────────────────────────────

export type ToolCallStateType = 'requested' | 'approved' | 'denied' | 'running' | 'succeeded' | 'failed' | 'retrying' | 'skipped';

export interface ToolCallStateRecord {
  id: string;
  sessionId: string;
  runSpecId?: string;
  taskRunId?: string;
  turn: number;
  toolName: string;
  state: ToolCallStateType;
  inputJson: Record<string, unknown>;
  outputSummary?: string;
  error?: string;
  durationMs?: number;
  attempt: number;
  maxAttempts: number;
  idempotent: boolean;
  retryPolicyJson: Record<string, unknown>;
  requestedAt: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateToolCallStateInput {
  id: string;
  sessionId: string;
  runSpecId?: string;
  taskRunId?: string;
  turn: number;
  toolName: string;
  state?: ToolCallStateType;
  inputJson?: Record<string, unknown>;
  maxAttempts?: number;
  idempotent?: boolean;
  retryPolicy?: Record<string, unknown>;
}

export interface UpdateToolCallStateInput {
  state: ToolCallStateType;
  outputSummary?: string;
  error?: string | null;
  durationMs?: number;
  attempt?: number;
}

// ── Schema ──────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tool_call_states (
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  run_spec_id TEXT,
  task_run_id TEXT,
  turn INTEGER NOT NULL DEFAULT 0,
  tool_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'requested',
  input_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_summary TEXT,
  error TEXT,
  duration_ms INTEGER,
  attempt INTEGER NOT NULL DEFAULT 1,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  idempotent BOOLEAN NOT NULL DEFAULT false,
  retry_policy_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_tool_call_states_session ON tool_call_states(session_id, turn, id);
CREATE INDEX IF NOT EXISTS idx_tool_call_states_run_spec ON tool_call_states(run_spec_id);
CREATE INDEX IF NOT EXISTS idx_tool_call_states_task_run ON tool_call_states(task_run_id);
CREATE INDEX IF NOT EXISTS idx_tool_call_states_tool ON tool_call_states(tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_call_states_state ON tool_call_states(state);
`;

let _initialized = false;

export async function ensureToolCallStateStore(): Promise<void> {
  if (_initialized) return;
  const db = getDb();
  await db.exec(SCHEMA);
  _initialized = true;
}

// ── CRUD ────────────────────────────────────────────────

export async function createToolCallState(input: CreateToolCallStateInput): Promise<ToolCallStateRecord> {
  await ensureToolCallStateStore();
  const db = getDb();
  const rows = await db.query<ToolCallStateRow>(
    `
    INSERT INTO tool_call_states (
      id, session_id, run_spec_id, task_run_id, turn, tool_name, state,
      input_json, max_attempts, idempotent, retry_policy_json
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11::jsonb)
    ON CONFLICT (id, session_id)
    DO UPDATE SET
      state = EXCLUDED.state,
      input_json = EXCLUDED.input_json,
      updated_at = now()
    RETURNING *
  `,
    [
      input.id,
      input.sessionId,
      input.runSpecId ?? null,
      input.taskRunId ?? null,
      input.turn,
      input.toolName,
      input.state ?? 'requested',
      JSON.stringify(input.inputJson ?? {}),
      input.maxAttempts ?? 1,
      input.idempotent ?? false,
      JSON.stringify(input.retryPolicy ?? {}),
    ],
  );
  return rowToRecord(assertRow(rows.rows[0]));
}

export async function updateToolCallState(
  id: string,
  sessionId: string,
  input: UpdateToolCallStateInput,
): Promise<ToolCallStateRecord | null> {
  await ensureToolCallStateStore();
  const db = getDb();
  const rows = await db.query<ToolCallStateRow>(
    `
    UPDATE tool_call_states
    SET state = $3,
        output_summary = COALESCE($4, output_summary),
        error = $5,
        duration_ms = COALESCE($6, duration_ms),
        attempt = COALESCE($7, attempt),
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
    RETURNING *
  `,
    [
      id,
      sessionId,
      input.state,
      input.outputSummary ?? null,
      input.error ?? null,
      input.durationMs ?? null,
      input.attempt ?? null,
    ],
  );
  return rows.rows[0] ? rowToRecord(rows.rows[0]) : null;
}

export async function loadToolCallState(
  id: string,
  sessionId: string,
): Promise<ToolCallStateRecord | null> {
  await ensureToolCallStateStore();
  const db = getDb();
  const rows = await db.query<ToolCallStateRow>(
    'SELECT * FROM tool_call_states WHERE id = $1 AND session_id = $2',
    [id, sessionId],
  );
  return rows.rows[0] ? rowToRecord(rows.rows[0]) : null;
}

export async function listToolCallStates(
  sessionId: string,
  limit = 100,
): Promise<ToolCallStateRecord[]> {
  await ensureToolCallStateStore();
  const db = getDb();
  const rows = await db.query<ToolCallStateRow>(
    'SELECT * FROM tool_call_states WHERE session_id = $1 ORDER BY turn, id LIMIT $2',
    [sessionId, limit],
  );
  return rows.rows.map(rowToRecord);
}

export async function listToolCallStatesForTaskRun(
  taskRunId: string,
  limit = 100,
): Promise<ToolCallStateRecord[]> {
  await ensureToolCallStateStore();
  const db = getDb();
  const rows = await db.query<ToolCallStateRow>(
    'SELECT * FROM tool_call_states WHERE task_run_id = $1 ORDER BY turn, id LIMIT $2',
    [taskRunId, limit],
  );
  return rows.rows.map(rowToRecord);
}

export async function listToolCallStatesForRunSpec(
  runSpecId: string,
  limit = 1000,
): Promise<ToolCallStateRecord[]> {
  await ensureToolCallStateStore();
  const db = getDb();
  const rows = await db.query<ToolCallStateRow>(
    'SELECT * FROM tool_call_states WHERE run_spec_id = $1 ORDER BY turn, id LIMIT $2',
    [runSpecId, limit],
  );
  return rows.rows.map(rowToRecord);
}

// ── Helpers ─────────────────────────────────────────────

type ToolCallStateRow = {
  id: string;
  session_id: string;
  run_spec_id: string | null;
  task_run_id: string | null;
  turn: number;
  tool_name: string;
  state: string;
  input_json: unknown;
  output_summary: string | null;
  error: string | null;
  duration_ms: number | null;
  attempt: number;
  max_attempts: number;
  idempotent: boolean;
  retry_policy_json: unknown;
  requested_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function rowToRecord(row: ToolCallStateRow): ToolCallStateRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    runSpecId: row.run_spec_id ?? undefined,
    taskRunId: row.task_run_id ?? undefined,
    turn: row.turn,
    toolName: row.tool_name,
    state: row.state as ToolCallStateType,
    inputJson: normalizeJsonObject(row.input_json),
    outputSummary: row.output_summary ?? undefined,
    error: row.error ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    idempotent: row.idempotent,
    retryPolicyJson: normalizeJsonObject(row.retry_policy_json),
    requestedAt: toIsoString(row.requested_at),
    startedAt: row.started_at ? toIsoString(row.started_at) : undefined,
    completedAt: row.completed_at ? toIsoString(row.completed_at) : undefined,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const p = JSON.parse(value);
      return p && typeof p === 'object' && !Array.isArray(p) ? p as Record<string, unknown> : {};
    } catch { return {}; }
  }
  return {};
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('Failed to create tool call state');
  return row;
}
