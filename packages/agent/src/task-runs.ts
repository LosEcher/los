/**
 * @los/agent/task-runs — Minimal persistent task lifecycle records.
 *
 * This is the project-task layer above chat sessions:
 * queued -> running -> succeeded/failed/cancelled
 */

import { getDb } from '@los/infra/db';

export type TaskRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface TaskRunRecord {
  id: string;
  sessionId: string;
  traceId: string;
  dedupeKey?: string;
  workspaceRoot: string;
  toolMode: string;
  provider?: string;
  status: TaskRunStatus;
  attempt: number;
  promptPreview: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface CreateTaskRunInput {
  id: string;
  sessionId: string;
  traceId?: string;
  dedupeKey?: string;
  workspaceRoot: string;
  toolMode: string;
  provider?: string;
  promptPreview: string;
  metadata?: Record<string, unknown>;
  status?: TaskRunStatus;
  attempt?: number;
}

export interface UpdateTaskRunInput {
  status?: TaskRunStatus;
  metadata?: Record<string, unknown>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  trace_id TEXT,
  dedupe_key TEXT,
  workspace_root TEXT NOT NULL,
  tool_mode TEXT NOT NULL,
  provider TEXT,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  prompt_preview TEXT NOT NULL DEFAULT '',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS trace_id TEXT;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 1;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_task_runs_session_id ON task_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_trace_id ON task_runs(trace_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_dedupe_key ON task_runs(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status);
CREATE INDEX IF NOT EXISTS idx_task_runs_updated ON task_runs(updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_runs_active_dedupe
  ON task_runs(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');
`;

let _initialized = false;

export async function ensureTaskRunStore(): Promise<void> {
  if (_initialized) return;
  const db = getDb();
  await db.exec(SCHEMA);
  _initialized = true;
}

export async function createTaskRun(input: CreateTaskRunInput): Promise<TaskRunRecord> {
  await ensureTaskRunStore();
  const db = getDb();
  const rows = await db.query<TaskRunRow>(
    `
    INSERT INTO task_runs (
      id, session_id, trace_id, dedupe_key, workspace_root, tool_mode, provider, status,
      attempt, prompt_preview, metadata_json, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, now())
    RETURNING *
  `,
    [
      input.id,
      input.sessionId,
      input.traceId ?? input.id,
      input.dedupeKey ?? null,
      input.workspaceRoot,
      input.toolMode,
      input.provider ?? null,
      input.status ?? 'queued',
      input.attempt ?? 1,
      input.promptPreview,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return rowToTaskRun(assertRow(rows.rows[0]));
}

export async function updateTaskRun(id: string, updates: UpdateTaskRunInput): Promise<TaskRunRecord | null> {
  await ensureTaskRunStore();
  const db = getDb();
  const existing = await loadTaskRun(id);
  if (!existing) return null;

  const status = updates.status ?? existing.status;
  const metadata = updates.metadata ?? existing.metadata;

  const rows = await db.query<TaskRunRow>(
    `
    UPDATE task_runs
    SET status = $2,
        metadata_json = $3::jsonb,
        updated_at = now(),
        started_at = CASE
          WHEN $2 = 'running' AND started_at IS NULL THEN now()
          ELSE started_at
        END,
        completed_at = CASE
          WHEN $2 IN ('succeeded', 'failed', 'cancelled') THEN now()
          ELSE completed_at
        END
    WHERE id = $1
    RETURNING *
  `,
    [id, status, JSON.stringify(metadata)],
  );
  return rows.rows[0] ? rowToTaskRun(rows.rows[0]) : null;
}

export async function loadTaskRun(id: string): Promise<TaskRunRecord | null> {
  await ensureTaskRunStore();
  const db = getDb();
  const rows = await db.query<TaskRunRow>('SELECT * FROM task_runs WHERE id = $1', [id]);
  return rows.rows[0] ? rowToTaskRun(rows.rows[0]) : null;
}

export async function findActiveTaskRunByDedupeKey(dedupeKey: string): Promise<TaskRunRecord | null> {
  await ensureTaskRunStore();
  const normalized = dedupeKey.trim();
  if (!normalized) return null;

  const db = getDb();
  const rows = await db.query<TaskRunRow>(
    `
    SELECT *
    FROM task_runs
    WHERE dedupe_key = $1
      AND status IN ('queued', 'running')
    ORDER BY updated_at DESC
    LIMIT 1
  `,
    [normalized],
  );
  return rows.rows[0] ? rowToTaskRun(rows.rows[0]) : null;
}

export async function listTaskRuns(limit = 50): Promise<TaskRunRecord[]> {
  await ensureTaskRunStore();
  const db = getDb();
  const rows = await db.query<TaskRunRow>(
    'SELECT * FROM task_runs ORDER BY updated_at DESC LIMIT $1',
    [limit],
  );
  return rows.rows.map(rowToTaskRun);
}

type TaskRunRow = {
  id: string;
  session_id: string;
  trace_id: string | null;
  dedupe_key: string | null;
  workspace_root: string;
  tool_mode: string;
  provider: string | null;
  status: TaskRunStatus;
  attempt: number | null;
  prompt_preview: string;
  metadata_json: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
};

function rowToTaskRun(row: TaskRunRow): TaskRunRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    traceId: row.trace_id ?? row.id,
    dedupeKey: row.dedupe_key ?? undefined,
    workspaceRoot: row.workspace_root,
    toolMode: row.tool_mode,
    provider: row.provider ?? undefined,
    status: row.status,
    attempt: row.attempt ?? 1,
    promptPreview: row.prompt_preview,
    metadata: normalizeJsonObject(row.metadata_json),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    startedAt: row.started_at ? toIsoString(row.started_at) : undefined,
    completedAt: row.completed_at ? toIsoString(row.completed_at) : undefined,
  };
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertRow<T>(row: T | undefined): T {
  if (!row) {
    throw new Error('Failed to create task run');
  }
  return row;
}
