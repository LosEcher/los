ALTER TABLE idempotency_keys
  ADD COLUMN IF NOT EXISTS owner_id TEXT;

ALTER TABLE idempotency_keys
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_idempotency_processing_lease
  ON idempotency_keys(lease_expires_at)
  WHERE status = 'processing';
