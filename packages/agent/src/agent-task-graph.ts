import { getDb, withDbClient } from '@los/infra/db';
import {
  normalizeEditableSurfaceMode,
  selectEditableSurfaceCompatibleTasks,
} from './agent-task-editable-surfaces.js';
import {
  recordClaimSchedulerDecision,
  type ClaimDecisionContext,
} from './scheduler/claim-decision.js';
import { normalizeOptionalString } from './scheduler/helpers.js';
import type {
  AgentTaskAttemptRecord,
  AgentTaskAttemptStatus,
  AgentTaskEdgeRecord,
  AgentTaskRecord,
  AgentTaskLeaseFence,
  AgentTaskRole,
  AgentTaskStatus,
  ClaimReadyAgentTasksInput,
  CreateAgentTaskAttemptInput,
  CreateAgentTaskInput,
  LinkAgentTaskDependencyInput,
} from './agent-task-graph/types.js';

import {
  assertRow,
  normalizeAttemptStatus,
  normalizeOptionalNumber,
  normalizePriority,
  normalizeRequiredString,
  normalizeRole,
  normalizeTaskStatus,
  toIsoString,
  uniqueStrings,
} from './agent-task-graph/normalizers.js';
import {
  rowToTask,
  rowToEdge,
  rowToAttempt,
  type AgentTaskRow,
  type AgentTaskEdgeRow,
  type AgentTaskAttemptRow,
} from './agent-task-graph/rows.js';

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
  AgentTaskLeaseFence,
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
  lease_version BIGINT NOT NULL DEFAULT 0,
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

ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS lease_version BIGINT NOT NULL DEFAULT 0;
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
  let decisionContext: ClaimDecisionContext | undefined;
  const claimed = await withDbClient(async (client) => {
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
      const claimDecision = {
        graphId: input.graphId,
        nodeId: input.nodeId,
        limit,
        candidateLimit,
        mode,
        candidates: candidates.rows.map(rowToTask),
        runningTasks: runningRows.map(rowToTask),
      };
      if (selected.length === 0) {
        decisionContext = {
          ...claimDecision,
          selected: [],
        };
        await client.query('COMMIT');
        return [];
      }

      const rows = await client.query<AgentTaskRow>(
        `
        UPDATE agent_tasks task
        SET status = 'running',
            claimed_by_node_id = $3,
            lease_version = lease_version + 1,
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
      const claimedTasks = rows.rows
        .map(rowToTask)
        .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      decisionContext = {
        ...claimDecision,
        selected: claimedTasks,
      };
      return claimedTasks;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  });
  if (decisionContext) {
    await recordClaimSchedulerDecision(decisionContext);
  }
  return claimed;
}

export async function updateAgentTaskStatus(
  id: string,
  status: AgentTaskStatus,
  metadata?: Record<string, unknown>,
  fence?: AgentTaskLeaseFence,
): Promise<AgentTaskRecord | null> {
  await ensureAgentTaskGraphStore();
  const db = getDb();
  const rows = await db.query<AgentTaskRow>(
    `
    UPDATE agent_tasks
    SET status = $2,
        metadata_json = CASE WHEN $3::jsonb IS NULL THEN metadata_json ELSE metadata_json || $3::jsonb END,
        completed_at = CASE WHEN $2 IN ('succeeded', 'failed', 'cancelled') THEN now() ELSE completed_at END,
        claimed_by_node_id = CASE WHEN $2 IN ('queued', 'succeeded', 'failed', 'cancelled', 'blocked') THEN NULL ELSE claimed_by_node_id END,
        lease_expires_at = CASE WHEN $2 IN ('queued', 'succeeded', 'failed', 'cancelled', 'blocked') THEN NULL ELSE lease_expires_at END,
        updated_at = now()
    WHERE id = $1
      AND (
        $4::text IS NULL
        OR (
          claimed_by_node_id = $4
          AND lease_version = $5
          AND lease_expires_at > now()
        )
      )
    RETURNING *
  `,
    [
      id,
      normalizeTaskStatus(status),
      metadata ? JSON.stringify(metadata) : null,
      fence?.nodeId ?? null,
      fence?.leaseVersion ?? null,
    ],
  );
  return rows.rows[0] ? rowToTask(rows.rows[0]) : null;
}

export async function claimBlockedAgentTask(
  id: string,
  input: { nodeId: string; leaseMs?: number },
): Promise<AgentTaskRecord | null> {
  await ensureAgentTaskGraphStore();
  const leaseMs = Math.max(1_000, Math.min(86_400_000, Math.floor(input.leaseMs ?? 30_000)));
  const rows = await getDb().query<AgentTaskRow>(
    `
    UPDATE agent_tasks
    SET status = 'running',
        claimed_by_node_id = $2,
        lease_version = lease_version + 1,
        lease_expires_at = now() + ($3::text || ' milliseconds')::interval,
        completed_at = NULL,
        updated_at = now()
    WHERE id = $1
      AND status = 'blocked'
    RETURNING *
  `,
    [id, input.nodeId, leaseMs],
  );
  return rows.rows[0] ? rowToTask(rows.rows[0]) : null;
}

export {
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


export { rowToTask, type AgentTaskRow } from './agent-task-graph/rows.js';
