-- 066_created_at_indexes: give the time-window reads a migration-owned index
--
-- The ensure*Store schemas added `idx_task_runs_created` and
-- `idx_scheduler_decisions_created` for windowed aggregation/read paths, but no
-- migration created them. A fresh migration-only database therefore disagreed
-- with the runtime schema (migration-drift `NEW MIGRATION DRIFT` on both).
--
-- Keep the definitions byte-for-byte aligned with:
--   packages/agent/src/task-runs/schema.ts
--   packages/agent/src/scheduler-decision-ledger.ts
--
-- See docs/architecture/2026-10-18-task-token-heartbeat-and-stateless-executor.md
-- for the branch that exposed this pre-existing drift.

CREATE INDEX IF NOT EXISTS idx_task_runs_created ON task_runs(created_at);
CREATE INDEX IF NOT EXISTS idx_scheduler_decisions_created ON scheduler_decisions(created_at DESC);
