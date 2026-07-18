ALTER TABLE dead_letter_events
  ADD COLUMN IF NOT EXISTS resolution TEXT,
  ADD COLUMN IF NOT EXISTS resolution_note TEXT,
  ADD COLUMN IF NOT EXISTS replacement_task_run_id TEXT,
  ADD COLUMN IF NOT EXISTS resolved_by TEXT,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

UPDATE dead_letter_events
SET resolution = 'legacy_acknowledged',
    resolved_by = 'migration:037',
    resolved_at = acknowledged_at
WHERE acknowledged_at IS NOT NULL
  AND resolution IS NULL;

CREATE INDEX IF NOT EXISTS idx_dead_letter_resolution
  ON dead_letter_events(resolution, resolved_at DESC)
  WHERE resolution IS NOT NULL;
