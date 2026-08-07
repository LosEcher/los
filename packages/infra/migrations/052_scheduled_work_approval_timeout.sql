-- 052_scheduled_work_approval_timeout.sql
-- Per-schedule approval timeout: how long an awaiting_approval run may wait
-- before the scheduler auto-disposes it, and what the auto disposition is.
-- Default: 30 minutes, auto-deny (conservative). Individual schedules may be
-- overridden to auto-approve via the web/API.

ALTER TABLE scheduled_work_items ADD COLUMN IF NOT EXISTS approval_timeout_ms INTEGER NOT NULL DEFAULT 1800000;
ALTER TABLE scheduled_work_items ADD COLUMN IF NOT EXISTS approval_timeout_action TEXT NOT NULL DEFAULT 'deny';
ALTER TABLE scheduled_work_items ADD CONSTRAINT scheduled_work_items_timeout_action_chk
  CHECK (approval_timeout_action IN ('deny', 'approve'));
