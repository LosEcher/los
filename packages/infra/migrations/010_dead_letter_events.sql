CREATE TABLE IF NOT EXISTS dead_letter_events (
  id TEXT PRIMARY KEY,
  task_run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  run_spec_id TEXT REFERENCES run_specs(id) ON DELETE SET NULL,
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
