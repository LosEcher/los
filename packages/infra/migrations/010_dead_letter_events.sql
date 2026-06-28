CREATE TABLE IF NOT EXISTS dead_letter_events (
  id TEXT PRIMARY KEY,
  task_run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  -- run_spec_id FK is added in migration 025 (post_run_specs_forward_refs),
  -- after run_specs is created by migration 013. An inline REFERENCES here
  -- would fail on a fresh DB because run_specs does not exist at seq 010.
  run_spec_id TEXT,
  reason TEXT NOT NULL,
  original_error TEXT,
  event_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dead_letter_unacknowledged
  ON dead_letter_events(created_at DESC)
  WHERE acknowledged_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_dead_letter_task_run
  ON dead_letter_events(task_run_id);

CREATE INDEX IF NOT EXISTS idx_dead_letter_reason
  ON dead_letter_events(reason);
