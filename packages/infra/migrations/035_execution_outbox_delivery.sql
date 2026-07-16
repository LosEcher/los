-- 035_execution_outbox_delivery: reliable at-least-once notification publisher

ALTER TABLE execution_outbox
  ADD COLUMN IF NOT EXISTS session_event_id BIGINT,
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS claimed_by TEXT,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS legacy BOOLEAN NOT NULL DEFAULT TRUE;

-- Rows present at upgrade time are the operator-approved historical watermark.
-- Fresh rows written after this migration are eligible for delivery.
ALTER TABLE execution_outbox ALTER COLUMN legacy SET DEFAULT FALSE;

DROP INDEX IF EXISTS idx_execution_outbox_unpublished;
CREATE INDEX idx_execution_outbox_unpublished
  ON execution_outbox(next_attempt_at, id)
  WHERE published_at IS NULL AND legacy = FALSE;

CREATE INDEX IF NOT EXISTS idx_execution_outbox_claim
  ON execution_outbox(claimed_at, id)
  WHERE published_at IS NULL AND legacy = FALSE;
