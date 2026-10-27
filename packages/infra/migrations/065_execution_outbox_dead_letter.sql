-- 065_execution_outbox_dead_letter: stop retrying a poison outbox row forever
--
-- Before this migration `execution_outbox` had no terminal state: a delivery
-- that always failed was retried with exponential backoff capped at 60s,
-- forever (the maintenance loop runs every second). The cap is N=8 attempts;
-- the 8th failure marks the row dead-lettered and hands it to the existing
-- `dead_letter_events` disposal path. Nothing is auto-replayed.
--
-- See docs/architecture/2026-10-10-control-plane-truth-remediation.md §3.

ALTER TABLE execution_outbox
  ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ;

-- Keep dead rows out of the claim hot path. The predicates deliberately do NOT
-- copy the claim SQL's `next_attempt_at <= now()` or the `claimed_at` lease:
-- index predicates cannot call now(), and copying the lease would make the
-- index wrong for rows that are merely waiting out their backoff.
DROP INDEX IF EXISTS idx_execution_outbox_unpublished;
CREATE INDEX idx_execution_outbox_unpublished
  ON execution_outbox(next_attempt_at, id)
  WHERE published_at IS NULL AND legacy = FALSE AND dead_lettered_at IS NULL;

DROP INDEX IF EXISTS idx_execution_outbox_claim;
CREATE INDEX idx_execution_outbox_claim
  ON execution_outbox(claimed_at, id)
  WHERE published_at IS NULL AND legacy = FALSE AND dead_lettered_at IS NULL;
