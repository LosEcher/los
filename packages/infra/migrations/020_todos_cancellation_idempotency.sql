-- 020_todos_cancellation_idempotency.sql
-- todos, todo_dependencies, cancellation_requests, idempotency_keys

CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'local',
  project_id TEXT NOT NULL DEFAULT 'los',
  user_id TEXT,
  node_id TEXT,
  stage_id TEXT,
  parent_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'task',
  status TEXT NOT NULL DEFAULT 'backlog',
  priority TEXT NOT NULL DEFAULT 'P1',
  source TEXT,
  trace_id TEXT,
  request_id TEXT,
  dedupe_key TEXT,
  task_run_id TEXT,
  session_id TEXT,
  batch_key TEXT,
  depends_on_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  run_contract_json JSONB,
  archive_reason TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  reopened_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status);
CREATE INDEX IF NOT EXISTS idx_todos_tenant_project ON todos(tenant_id, project_id);
CREATE INDEX IF NOT EXISTS idx_todos_dedupe ON todos(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_todos_stage ON todos(stage_id);

CREATE TABLE IF NOT EXISTS todo_dependencies (
  todo_id TEXT NOT NULL,
  depends_on_todo_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'blocks',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (todo_id, depends_on_todo_id)
);

CREATE TABLE IF NOT EXISTS cancellation_requests (
  task_run_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT '',
  requested_by TEXT NOT NULL DEFAULT '',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cancellation_requests_requested_at ON cancellation_requests(requested_at);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'local',
  route TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  response_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  task_run_id TEXT,
  todo_id TEXT,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_lookup ON idempotency_keys(tenant_id, route, idempotency_key);
