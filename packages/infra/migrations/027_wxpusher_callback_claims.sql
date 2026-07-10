CREATE TABLE IF NOT EXISTS wxpusher_callback_claims (
  replay_key TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wxpusher_callback_claims_state_chk
    CHECK (state IN ('processing', 'accepted', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_wxpusher_callback_claims_expires
  ON wxpusher_callback_claims(expires_at);
