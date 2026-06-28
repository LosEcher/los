-- 023_agent_task_graph.sql
-- agent_tasks, task_edges, task_attempts
--
-- Canonical schema mirrors the runtime ensure*Store definition in
-- packages/agent/src/agent-task-graph.ts. These tables previously existed
-- only via ensure*Store (no migration), so a fresh `db:migrate` did not
-- create them. Idempotent.

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

CREATE INDEX IF NOT EXISTS idx_agent_tasks_graph_status
  ON agent_tasks(graph_id, status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_run_spec
  ON agent_tasks(run_spec_id);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_session
  ON agent_tasks(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_lease
  ON agent_tasks(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_task_edges_graph_task
  ON task_edges(graph_id, task_id);
CREATE INDEX IF NOT EXISTS idx_task_edges_graph_depends
  ON task_edges(graph_id, depends_on_task_id);
CREATE INDEX IF NOT EXISTS idx_task_attempts_task
  ON task_attempts(graph_id, task_id, attempt);
