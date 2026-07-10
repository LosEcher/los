ALTER TABLE telegram_action_tokens
  ADD COLUMN IF NOT EXISTS decision_group_id TEXT;

UPDATE telegram_action_tokens
SET decision_group_id = token
WHERE decision_group_id IS NULL;

ALTER TABLE telegram_action_tokens
  ALTER COLUMN decision_group_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_telegram_action_tokens_decision_group
  ON telegram_action_tokens(decision_group_id);
