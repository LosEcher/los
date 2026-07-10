CREATE TABLE IF NOT EXISTS telegram_action_tokens (
  token TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('approve', 'deny', 'escalate')),
  session_id TEXT NOT NULL,
  call_id TEXT NOT NULL DEFAULT '',
  decision_group_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'consumed')),
  claim_id TEXT,
  lease_expires_at TIMESTAMPTZ,
  consumed_callback_id TEXT,
  consumed_user_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_telegram_action_tokens_expiry
  ON telegram_action_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_telegram_action_tokens_status_lease
  ON telegram_action_tokens(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_telegram_action_tokens_decision_group
  ON telegram_action_tokens(decision_group_id);
