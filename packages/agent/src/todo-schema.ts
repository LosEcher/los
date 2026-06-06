export const TODO_SCHEMA = `
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
  priority TEXT NOT NULL DEFAULT 'P2',
  source TEXT NOT NULL DEFAULT 'manual',
  trace_id TEXT,
  request_id TEXT,
  dedupe_key TEXT,
  task_run_id TEXT,
  session_id TEXT,
  batch_key TEXT,
  archived_at TIMESTAMPTZ,
  archive_reason TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  reopened_at TIMESTAMPTZ
);

ALTER TABLE todos ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS archive_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_todos_tenant_project ON todos(tenant_id, project_id);
CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status);
CREATE INDEX IF NOT EXISTS idx_todos_kind ON todos(kind);
CREATE INDEX IF NOT EXISTS idx_todos_priority ON todos(priority);
CREATE INDEX IF NOT EXISTS idx_todos_parent ON todos(parent_id);
CREATE INDEX IF NOT EXISTS idx_todos_stage ON todos(stage_id);
CREATE INDEX IF NOT EXISTS idx_todos_trace ON todos(trace_id);
CREATE INDEX IF NOT EXISTS idx_todos_request ON todos(request_id);
CREATE INDEX IF NOT EXISTS idx_todos_task_run ON todos(task_run_id);
CREATE INDEX IF NOT EXISTS idx_todos_session ON todos(session_id);
CREATE INDEX IF NOT EXISTS idx_todos_source ON todos(source);
CREATE INDEX IF NOT EXISTS idx_todos_batch ON todos(batch_key);
CREATE INDEX IF NOT EXISTS idx_todos_dedupe ON todos(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_todos_node ON todos(node_id);
CREATE INDEX IF NOT EXISTS idx_todos_archived ON todos(archived_at);
CREATE INDEX IF NOT EXISTS idx_todos_updated ON todos(updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_project_dedupe
  ON todos(tenant_id, project_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS todo_dependencies (
  todo_id TEXT NOT NULL,
  depends_on_todo_id TEXT NOT NULL,
  relation_type TEXT NOT NULL DEFAULT 'blocks',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (todo_id, depends_on_todo_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_todo_dependencies_todo_id ON todo_dependencies(todo_id);
CREATE INDEX IF NOT EXISTS idx_todo_dependencies_depends_on ON todo_dependencies(depends_on_todo_id);
`;
