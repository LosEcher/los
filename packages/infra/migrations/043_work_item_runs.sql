-- 043_work_item_runs.sql
-- Work Item lineage only. Todos and execution stores retain state ownership.

CREATE TABLE IF NOT EXISTS work_item_runs (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  run_spec_id TEXT,
  task_run_id TEXT,
  session_id TEXT,
  relation_kind TEXT NOT NULL DEFAULT 'execution',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT work_item_runs_target_chk CHECK (
    run_spec_id IS NOT NULL OR task_run_id IS NOT NULL OR session_id IS NOT NULL
  ),
  CONSTRAINT work_item_runs_relation_chk CHECK (
    relation_kind IN ('discovery', 'planning', 'execution', 'verification', 'recovery', 'closeout')
  )
);

CREATE INDEX IF NOT EXISTS idx_work_item_runs_work_item
  ON work_item_runs(work_item_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_item_runs_run_spec ON work_item_runs(run_spec_id);
CREATE INDEX IF NOT EXISTS idx_work_item_runs_task_run ON work_item_runs(task_run_id);
CREATE INDEX IF NOT EXISTS idx_work_item_runs_session ON work_item_runs(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_item_runs_unique_run_spec
  ON work_item_runs(work_item_id, run_spec_id)
  WHERE run_spec_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_item_runs_unique_task_run
  ON work_item_runs(work_item_id, task_run_id)
  WHERE task_run_id IS NOT NULL;
