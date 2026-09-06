CREATE TABLE IF NOT EXISTS node_enrollment_tokens (
  token_hash TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_node_enrollment_tokens_expiry ON node_enrollment_tokens(expires_at);
CREATE TABLE IF NOT EXISTS node_enrollments (
  node_id TEXT PRIMARY KEY,
  credential_hash TEXT NOT NULL UNIQUE,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
