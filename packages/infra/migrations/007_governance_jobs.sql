-- 007_governance_jobs.sql
-- Governance job configuration and results store per governance-module-boundary.md.
-- Stores cadence, scope, thresholds, and result summaries.
-- Execution evidence lives in task_runs/session_events — not here.

CREATE TABLE IF NOT EXISTS governance_jobs (
  id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL CHECK (job_type IN ('consistency_audit', 'hotspot', 'architecture_drift', 'tool_drift', 'provider_surveillance')),
  cadence TEXT NOT NULL CHECK (cadence IN ('daily', 'weekly', 'release_gate', 'manual')),
  tenant_id TEXT,
  project_id TEXT,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_run_at TIMESTAMPTZ,
  last_task_run_id TEXT,
  result_summary_json JSONB,
  dedupe_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gov_jobs_type_cadence ON governance_jobs(job_type, cadence, enabled, last_run_at);
CREATE INDEX IF NOT EXISTS idx_gov_jobs_tenant_project ON governance_jobs(tenant_id, project_id);
CREATE INDEX IF NOT EXISTS idx_gov_jobs_dedupe ON governance_jobs(dedupe_key);
