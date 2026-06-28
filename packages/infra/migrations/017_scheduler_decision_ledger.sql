-- 017_scheduler_decision_ledger.sql
-- scheduler_decisions, execution_outbox (from execution-store.ts)

CREATE TABLE IF NOT EXISTS scheduler_decisions (
  id TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL,
  task_id TEXT,
  attempt_id TEXT,
  task_run_id TEXT,
  run_spec_id TEXT,
  session_id TEXT,
  node_id TEXT,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  selected_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  skipped_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scheduler_decisions_graph ON scheduler_decisions(graph_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduler_decisions_kind ON scheduler_decisions(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduler_decisions_session ON scheduler_decisions(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduler_decisions_task ON scheduler_decisions(task_id, created_at DESC);

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
CREATE INDEX IF NOT EXISTS idx_execution_outbox_unpublished ON execution_outbox(created_at, id) WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_execution_outbox_session ON execution_outbox(session_id, id);
CREATE INDEX IF NOT EXISTS idx_execution_outbox_run_spec ON execution_outbox(run_spec_id, id);
CREATE INDEX IF NOT EXISTS idx_execution_outbox_entity ON execution_outbox(entity_type, entity_id, id);
