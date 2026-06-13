import { getDb, withDbClient } from '@los/infra/db';
import {
  normalizeEditableSurfaceMode,
  selectEditableSurfaceCompatibleTasks,
} from './agent-task-editable-surfaces.js';
import { normalizeOptionalString } from './scheduler/helpers.js';
import type {
  AgentTaskAttemptRecord,
  AgentTaskAttemptStatus,
  AgentTaskEdgeRecord,
  AgentTaskRecord,
  AgentTaskRole,
  AgentTaskStatus,
  ClaimReadyAgentTasksInput,
  CreateAgentTaskAttemptInput,
  CreateAgentTaskInput,
  LinkAgentTaskDependencyInput,
} from './agent-task-graph/types.js';

export {
  editableSurfacesForAgentTask,
  editableSurfacesOverlap,
  selectEditableSurfaceCompatibleTasks,
} from './agent-task-editable-surfaces.js';
export type {
  AgentTaskAttemptRecord,
  AgentTaskAttemptStatus,
  AgentTaskEdgeRecord,
  AgentTaskRecord,
  AgentTaskRole,
  AgentTaskStatus,
  ClaimReadyAgentTasksInput,
  CreateAgentTaskAttemptInput,
  CreateAgentTaskInput,
  LinkAgentTaskDependencyInput,
} from './agent-task-graph/types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_tasks (
  id TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL,
  run_spec_id TEXT,
  session_id TEXT,
  role TEXT NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  priority INTEGER NOT NULL DEFAULT 100,
  confidence DOUBLE PRECISION,
  cost_estimate DOUBLE PRECISION,
  deadline_at TIMESTAMPTZ,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  claimed_by_node_id TEXT,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS task_edges (
  graph_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'blocks',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (graph_id, task_id, depends_on_task_id)
);

CREATE TABLE IF NOT EXISTS task_attempts (
  id TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'running',
  provider TEXT,
  model TEXT,
  node_id TEXT,
  task_run_id TEXT,
  verification_record_id TEXT,
  tool_call_state_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  output_summary TEXT,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_graph_status ON agent_tasks(graph_id, status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_run_spec ON agent_tasks(run_spec_id);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_session ON agent_tasks(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_lease ON agent_tasks(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_task_edges_graph_task ON task_edges(graph_id, task_id);
CREATE INDEX IF NOT EXISTS idx_task_edges_graph_depends ON task_edges(graph_id, depends_on_task_id);
CREATE INDEX IF NOT EXISTS idx_task_attempts_task ON task_attempts(graph_id, task_id, attempt);
`;

let _initialized = false;

export async function ensureAgentTaskGraphStore(): Promise<void> {
  if (_initialized) return;
  const db = getDb();
  await db.exec(SCHEMA);
  _initialized = true;
}

export async function createAgentTask(input: CreateAgentTaskInput): Promise<AgentTaskRecord> {
  await ensureAgentTaskGraphStore();
  const db = getDb();
  const rows = await db.query<AgentTaskRow>(
    `
    INSERT INTO agent_tasks (
      id, graph_id, run_spec_id, session_id, role, title, prompt, status,
      priority, confidence, cost_estimate, deadline_at, max_attempts, metadata_json
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13, $14::jsonb)
    ON CONFLICT (id) DO UPDATE SET
      graph_id = EXCLUDED.graph_id,
      run_spec_id = EXCLUDED.run_spec_id,
      session_id = EXCLUDED.session_id,
      role = EXCLUDED.role,
      title = EXCLUDED.title,
      prompt = EXCLUDED.prompt,
      status = EXCLUDED.status,
      priority = EXCLUDED.priority,
      confidence = EXCLUDED.confidence,
      cost_estimate = EXCLUDED.cost_estimate,
      deadline_at = EXCLUDED.deadline_at,
      max_attempts = EXCLUDED.max_attempts,
      metadata_json = EXCLUDED.metadata_json,
      updated_at = now()
    RETURNING *
  `,
    [
      input.id,
      input.graphId,
      input.runSpecId ?? null,
      input.sessionId ?? null,
      normalizeRole(input.role),
      normalizeRequiredString(input.title, 'title'),
      normalizeOptionalString(input.prompt) ?? null,
      normalizeTaskStatus(input.status),
      normalizePriority(input.priority),
      normalizeOptionalNumber(input.confidence) ?? null,
      normalizeOptionalNumber(input.costEstimate) ?? null,
      input.deadlineAt ? toIsoString(input.deadlineAt) : null,
      Math.max(1, Math.floor(input.maxAttempts ?? 1)),
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return rowToTask(assertRow(rows.rows[0]));
}

export async function linkAgentTaskDependency(input: LinkAgentTaskDependencyInput): Promise<AgentTaskEdgeRecord> {
  await ensureAgentTaskGraphStore();
  if (input.taskId === input.dependsOnTaskId) throw new Error('task cannot depend on itself');
  const db = getDb();
  const rows = await db.query<AgentTaskEdgeRow>(
    `
    INSERT INTO task_edges (graph_id, task_id, depends_on_task_id, kind, metadata_json)
    VALUES ($1, $2, $3, 'blocks', $4::jsonb)
    ON CONFLICT (graph_id, task_id, depends_on_task_id) DO UPDATE SET
      metadata_json = EXCLUDED.metadata_json
    RETURNING *
  `,
    [input.graphId, input.taskId, input.dependsOnTaskId, JSON.stringify(input.metadata ?? {})],
  );
  return rowToEdge(assertRow(rows.rows[0]));
}

export async function claimReadyAgentTasks(input: ClaimReadyAgentTasksInput): Promise<AgentTaskRecord[]> {
  await ensureAgentTaskGraphStore();
  const limit = Math.max(1, Math.min(50, Math.floor(input.limit ?? 1)));
  const leaseMs = Math.max(1_000, Math.min(86_400_000, Math.floor(input.leaseMs ?? 300_000)));
  const mode = normalizeEditableSurfaceMode(input.editableSurfaceMode);
  const candidateLimit = mode === 'ignore' ? limit : Math.min(200, Math.max(limit, limit * 4));
  return await withDbClient(async (client) => {
    await client.query('BEGIN');
    try {
      const candidates = await client.query<AgentTaskRow>(
        `
        WITH ready AS (
          SELECT task.*
          FROM agent_tasks task
          WHERE task.graph_id = $1
            AND task.status = 'queued'
            AND NOT EXISTS (
              SELECT 1
              FROM task_edges edge
              LEFT JOIN agent_tasks upstream ON upstream.graph_id = edge.graph_id AND upstream.id = edge.depends_on_task_id
              WHERE edge.graph_id = task.graph_id
                AND edge.task_id = task.id
                AND (upstream.id IS NULL OR upstream.status <> 'succeeded')
            )
          ORDER BY task.priority ASC, task.created_at ASC, task.id ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        )
        SELECT *
        FROM ready
      `,
        [input.graphId, candidateLimit],
      );
      const runningRows = mode === 'ignore'
        ? []
        : (await client.query<AgentTaskRow>(
          'SELECT * FROM agent_tasks WHERE graph_id = $1 AND status = $2 ORDER BY priority ASC, created_at ASC, id ASC',
          [input.graphId, 'running'],
        )).rows;
      const selected = selectEditableSurfaceCompatibleTasks(
        candidates.rows.map(rowToTask),
        limit,
        mode,
        runningRows.map(rowToTask),
      );
      if (selected.length === 0) {
        await client.query('COMMIT');
        return [];
      }

      const rows = await client.query<AgentTaskRow>(
        `
        UPDATE agent_tasks task
        SET status = 'running',
            claimed_by_node_id = $3,
            lease_expires_at = now() + ($4::text || ' milliseconds')::interval,
            started_at = COALESCE(started_at, now()),
            updated_at = now()
        WHERE task.graph_id = $1
          AND task.status = 'queued'
          AND task.id = ANY($2::text[])
        RETURNING task.*
      `,
        [input.graphId, selected.map(task => task.id), input.nodeId ?? null, leaseMs],
      );
      await client.query('COMMIT');
      const order = new Map(selected.map((task, index) => [task.id, index]));
      return rows.rows
        .map(rowToTask)
        .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  });
}

export async function updateAgentTaskStatus(
  id: string,
  status: AgentTaskStatus,
  metadata?: Record<string, unknown>,
): Promise<AgentTaskRecord | null> {
  await ensureAgentTaskGraphStore();
  const db = getDb();
  const rows = await db.query<AgentTaskRow>(
    `
    UPDATE agent_tasks
    SET status = $2,
        metadata_json = CASE WHEN $3::jsonb IS NULL THEN metadata_json ELSE metadata_json || $3::jsonb END,
        completed_at = CASE WHEN $2 IN ('succeeded', 'failed', 'cancelled') THEN now() ELSE completed_at END,
        lease_expires_at = CASE WHEN $2 IN ('succeeded', 'failed', 'cancelled', 'blocked') THEN NULL ELSE lease_expires_at END,
        updated_at = now()
    WHERE id = $1
    RETURNING *
  `,
    [id, normalizeTaskStatus(status), metadata ? JSON.stringify(metadata) : null],
  );
  return rows.rows[0] ? rowToTask(rows.rows[0]) : null;
}

export {
  AGENT_TASK_STARTUP_RECOVERY_LOCK_KEY,
  heartbeatAgentTask,
  recoverExpiredAgentTasks,
  recoverExpiredAgentTasksWithAdvisoryLock,
} from './agent-task-graph/lease.js';

export async function createAgentTaskAttempt(input: CreateAgentTaskAttemptInput): Promise<AgentTaskAttemptRecord> {
  await ensureAgentTaskGraphStore();
  const db = getDb();
  const rows = await db.query<AgentTaskAttemptRow>(
    `
    INSERT INTO task_attempts (
      id, graph_id, task_id, attempt, status, provider, model, node_id,
      task_run_id, verification_record_id, tool_call_state_ids_json, output_summary, error, completed_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13,
      CASE WHEN $5 IN ('succeeded', 'failed', 'cancelled') THEN now() ELSE NULL END
    )
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status,
      provider = EXCLUDED.provider,
      model = EXCLUDED.model,
      node_id = EXCLUDED.node_id,
      task_run_id = EXCLUDED.task_run_id,
      verification_record_id = EXCLUDED.verification_record_id,
      tool_call_state_ids_json = EXCLUDED.tool_call_state_ids_json,
      output_summary = EXCLUDED.output_summary,
      error = EXCLUDED.error,
      completed_at = EXCLUDED.completed_at,
      updated_at = now()
    RETURNING *
  `,
    [
      input.id,
      input.graphId,
      input.taskId,
      Math.max(1, Math.floor(input.attempt ?? 1)),
      normalizeAttemptStatus(input.status),
      normalizeOptionalString(input.provider) ?? null,
      normalizeOptionalString(input.model) ?? null,
      normalizeOptionalString(input.nodeId) ?? null,
      normalizeOptionalString(input.taskRunId) ?? null,
      normalizeOptionalString(input.verificationRecordId) ?? null,
      JSON.stringify(uniqueStrings(input.toolCallStateIds ?? [])),
      normalizeOptionalString(input.outputSummary) ?? null,
      normalizeOptionalString(input.error) ?? null,
    ],
  );
  return rowToAttempt(assertRow(rows.rows[0]));
}

export async function listAgentTasksForGraph(graphId: string): Promise<AgentTaskRecord[]> {
  await ensureAgentTaskGraphStore();
  const db = getDb();
  const rows = await db.query<AgentTaskRow>(
    'SELECT * FROM agent_tasks WHERE graph_id = $1 ORDER BY priority ASC, created_at ASC, id ASC',
    [graphId],
  );
  return rows.rows.map(rowToTask);
}

export async function listAgentTasksForRunSpec(runSpecId: string): Promise<AgentTaskRecord[]> {
  await ensureAgentTaskGraphStore();
  const db = getDb();
  const rows = await db.query<AgentTaskRow>(
    `
    SELECT *
    FROM agent_tasks
    WHERE run_spec_id = $1
    ORDER BY graph_id ASC, priority ASC, created_at ASC, id ASC
  `,
    [runSpecId],
  );
  return rows.rows.map(rowToTask);
}

export async function listAgentTaskEdgesForGraph(graphId: string): Promise<AgentTaskEdgeRecord[]> {
  await ensureAgentTaskGraphStore();
  const db = getDb();
  const rows = await db.query<AgentTaskEdgeRow>(
    'SELECT * FROM task_edges WHERE graph_id = $1 ORDER BY task_id ASC, depends_on_task_id ASC',
    [graphId],
  );
  return rows.rows.map(rowToEdge);
}

export async function listBlockedAgentTasks(graphId: string): Promise<AgentTaskRecord[]> {
  await ensureAgentTaskGraphStore();
  const db = getDb();
  const rows = await db.query<AgentTaskRow>(
    `
    SELECT DISTINCT task.*
    FROM agent_tasks task
    WHERE task.graph_id = $1
      AND (
        task.status = 'blocked'
        OR (
          task.status = 'queued'
          AND EXISTS (
            SELECT 1
            FROM task_edges edge
            JOIN agent_tasks upstream ON upstream.graph_id = edge.graph_id AND upstream.id = edge.depends_on_task_id
            WHERE edge.graph_id = task.graph_id
              AND edge.task_id = task.id
              AND upstream.status IN ('failed', 'cancelled')
          )
        )
      )
    ORDER BY task.priority ASC, task.created_at ASC, task.id ASC
  `,
    [graphId],
  );
  return rows.rows.map(rowToTask);
}

export async function listAgentTaskAttempts(taskId: string): Promise<AgentTaskAttemptRecord[]> {
  await ensureAgentTaskGraphStore();
  const db = getDb();
  const rows = await db.query<AgentTaskAttemptRow>(
    'SELECT * FROM task_attempts WHERE task_id = $1 ORDER BY attempt ASC, created_at ASC',
    [taskId],
  );
  return rows.rows.map(rowToAttempt);
}

type AgentTaskRow = {
  id: string;
  graph_id: string;
  run_spec_id: string | null;
  session_id: string | null;
  role: string;
  title: string;
  prompt: string | null;
  status: string;
  priority: number;
  confidence: number | null;
  cost_estimate: number | null;
  deadline_at: Date | string | null;
  max_attempts: number;
  metadata_json: unknown;
  claimed_by_node_id: string | null;
  lease_expires_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
};

export type { AgentTaskRow };

type AgentTaskEdgeRow = {
  graph_id: string;
  task_id: string;
  depends_on_task_id: string;
  kind: string;
  metadata_json: unknown;
  created_at: Date | string;
};

type AgentTaskAttemptRow = {
  id: string;
  graph_id: string;
  task_id: string;
  attempt: number;
  status: string;
  provider: string | null;
  model: string | null;
  node_id: string | null;
  task_run_id: string | null;
  verification_record_id: string | null;
  tool_call_state_ids_json: unknown;
  output_summary: string | null;
  error: string | null;
  started_at: Date | string;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export function rowToTask(row: AgentTaskRow): AgentTaskRecord {
  return {
    id: row.id,
    graphId: row.graph_id,
    runSpecId: row.run_spec_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    role: normalizeRole(row.role),
    title: row.title,
    prompt: row.prompt ?? undefined,
    status: normalizeTaskStatus(row.status),
    priority: row.priority,
    confidence: row.confidence ?? undefined,
    costEstimate: row.cost_estimate ?? undefined,
    deadlineAt: row.deadline_at ? toIsoString(row.deadline_at) : undefined,
    maxAttempts: row.max_attempts,
    metadata: normalizeJsonObject(row.metadata_json),
    claimedByNodeId: row.claimed_by_node_id ?? undefined,
    leaseExpiresAt: row.lease_expires_at ? toIsoString(row.lease_expires_at) : undefined,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    startedAt: row.started_at ? toIsoString(row.started_at) : undefined,
    completedAt: row.completed_at ? toIsoString(row.completed_at) : undefined,
  };
}

function rowToEdge(row: AgentTaskEdgeRow): AgentTaskEdgeRecord {
  return {
    graphId: row.graph_id,
    taskId: row.task_id,
    dependsOnTaskId: row.depends_on_task_id,
    kind: 'blocks',
    metadata: normalizeJsonObject(row.metadata_json),
    createdAt: toIsoString(row.created_at),
  };
}

function rowToAttempt(row: AgentTaskAttemptRow): AgentTaskAttemptRecord {
  return {
    id: row.id,
    graphId: row.graph_id,
    taskId: row.task_id,
    attempt: row.attempt,
    status: normalizeAttemptStatus(row.status),
    provider: row.provider ?? undefined,
    model: row.model ?? undefined,
    nodeId: row.node_id ?? undefined,
    taskRunId: row.task_run_id ?? undefined,
    verificationRecordId: row.verification_record_id ?? undefined,
    toolCallStateIds: normalizeJsonStringArray(row.tool_call_state_ids_json),
    outputSummary: row.output_summary ?? undefined,
    error: row.error ?? undefined,
    startedAt: toIsoString(row.started_at),
    completedAt: row.completed_at ? toIsoString(row.completed_at) : undefined,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function normalizeRole(value: unknown): AgentTaskRole {
  if (value === 'planner' || value === 'executor' || value === 'verifier') return value;
  return 'executor';
}

function normalizeTaskStatus(value: unknown): AgentTaskStatus {
  if (value === 'queued' || value === 'running' || value === 'succeeded' || value === 'failed' || value === 'cancelled' || value === 'blocked') return value;
  return 'queued';
}

function normalizeAttemptStatus(value: unknown): AgentTaskAttemptStatus {
  if (value === 'running' || value === 'succeeded' || value === 'failed' || value === 'cancelled') return value;
  return 'running';
}

function normalizePriority(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 100;
  return Math.max(0, Math.floor(value));
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function normalizeRequiredString(value: unknown, name: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function uniqueStrings(value: readonly string[]): string[] {
  return [...new Set(value.map(item => item.trim()).filter(Boolean))];
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

function normalizeJsonStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return uniqueStrings(value.filter((item): item is string => typeof item === 'string'));
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? normalizeJsonStringArray(parsed) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('agent task graph write returned no row');
  return row;
}
