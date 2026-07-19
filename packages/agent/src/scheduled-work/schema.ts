import { getDb } from '@los/infra/db';

import { ensureTodoStore } from '../todos.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS scheduled_work_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'local', project_id TEXT NOT NULL, user_id TEXT,
  title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'enabled',
  trigger_json JSONB NOT NULL, run_template_json JSONB NOT NULL,
  approval_policy TEXT NOT NULL DEFAULT 'read_only_auto',
  concurrency_policy TEXT NOT NULL DEFAULT 'skip', catch_up_policy TEXT NOT NULL DEFAULT 'skip',
  max_concurrent_runs INTEGER NOT NULL DEFAULT 1, max_lateness_ms INTEGER NOT NULL DEFAULT 3600000,
  max_attempts INTEGER NOT NULL DEFAULT 2, retry_backoff_ms INTEGER NOT NULL DEFAULT 60000,
  failure_threshold INTEGER NOT NULL DEFAULT 3, next_run_at TIMESTAMPTZ NOT NULL,
  circuit_state TEXT NOT NULL DEFAULT 'closed', circuit_opened_at TIMESTAMPTZ,
  consecutive_failures INTEGER NOT NULL DEFAULT 0, consecutive_no_ops INTEGER NOT NULL DEFAULT 0,
  recovery_work_item_id TEXT, revision INTEGER NOT NULL DEFAULT 1,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT scheduled_work_items_status_chk CHECK (status IN ('enabled', 'paused', 'retired')),
  CONSTRAINT scheduled_work_items_approval_chk CHECK (approval_policy IN ('read_only_auto', 'preapproved_scope', 'each_run')),
  CONSTRAINT scheduled_work_items_concurrency_chk CHECK (concurrency_policy IN ('skip', 'queue_one', 'parallel')),
  CONSTRAINT scheduled_work_items_catch_up_chk CHECK (catch_up_policy IN ('skip', 'run_once')),
  CONSTRAINT scheduled_work_items_circuit_chk CHECK (circuit_state IN ('closed', 'open', 'half_open'))
);
CREATE TABLE IF NOT EXISTS scheduled_work_item_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES scheduled_work_items(id) ON DELETE CASCADE,
  scheduled_for TIMESTAMPTZ NOT NULL, trigger_kind TEXT NOT NULL, status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 1, max_attempts INTEGER NOT NULL DEFAULT 2,
  claim_owner TEXT, lease_expires_at TIMESTAMPTZ,
  work_item_id TEXT REFERENCES todos(id) ON DELETE SET NULL, run_spec_id TEXT, task_run_id TEXT,
  result_summary_json JSONB, error TEXT, started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT scheduled_work_item_runs_status_chk CHECK (
    status IN ('queued', 'claimed', 'running', 'awaiting_approval', 'succeeded', 'no_op', 'skipped', 'failed', 'cancelled')
  ),
  CONSTRAINT scheduled_work_item_runs_trigger_chk CHECK (trigger_kind IN ('scheduled', 'manual', 'retry')),
  UNIQUE (schedule_id, scheduled_for)
);
CREATE INDEX IF NOT EXISTS idx_scheduled_work_due ON scheduled_work_items(status, circuit_state, next_run_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_work_project ON scheduled_work_items(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_work_runs_schedule ON scheduled_work_item_runs(schedule_id, scheduled_for DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_work_runs_lease ON scheduled_work_item_runs(status, lease_expires_at);
`;

let initialized = false;

export async function ensureScheduledWorkStore(): Promise<void> {
  if (initialized) return;
  await ensureTodoStore();
  await getDb().exec(SCHEMA);
  initialized = true;
}
