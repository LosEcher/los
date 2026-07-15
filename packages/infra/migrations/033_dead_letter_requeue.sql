ALTER TABLE dead_letter_events
  ADD COLUMN IF NOT EXISTS requeued_task_run_id TEXT,
  ADD COLUMN IF NOT EXISTS requeued_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS requeue_error TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_dead_letter_requeued_task_run
  ON dead_letter_events(requeued_task_run_id)
  WHERE requeued_task_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dead_letter_retryable
  ON dead_letter_events(created_at)
  WHERE reason = 'lease_expired'
    AND acknowledged_at IS NULL
    AND requeued_task_run_id IS NULL;
