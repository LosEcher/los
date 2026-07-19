-- 046_daily_agent_quality_snapshots.sql
-- Daily project-scoped aggregate evidence. Source stores retain state ownership.

CREATE TABLE IF NOT EXISTS daily_agent_quality_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'local',
  project_id TEXT NOT NULL,
  snapshot_date DATE NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  inbox_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  schedule_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  recovery_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  verification_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  provider_quality_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT daily_agent_quality_window_chk CHECK (window_start <= window_end),
  UNIQUE (tenant_id, project_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_agent_quality_project_date
  ON daily_agent_quality_snapshots(tenant_id, project_id, snapshot_date DESC);
