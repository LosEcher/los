-- 016_provider_evidence.sql
-- provider_compat_evidence, provider_promotion_decisions, provider_call_telemetry

CREATE TABLE IF NOT EXISTS provider_compat_evidence (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT,
  probe_id TEXT NOT NULL,
  target_label TEXT NOT NULL,
  decision TEXT NOT NULL DEFAULT 'advisory',
  passed BOOLEAN NOT NULL DEFAULT false,
  session_id TEXT,
  task_run_id TEXT,
  run_spec_id TEXT,
  trace_id TEXT,
  request_id TEXT,
  node_id TEXT,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  failures_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_provider_compat_evidence_provider ON provider_compat_evidence(provider, model);
CREATE INDEX IF NOT EXISTS idx_provider_compat_evidence_passed ON provider_compat_evidence(passed);
CREATE INDEX IF NOT EXISTS idx_provider_compat_evidence_created ON provider_compat_evidence(created_at DESC);

CREATE TABLE IF NOT EXISTS provider_promotion_decisions (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT,
  target_label TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  decision_by TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  evidence_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_provider_promotion_decisions_provider ON provider_promotion_decisions(provider, model);

CREATE TABLE IF NOT EXISTS provider_call_telemetry (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT,
  session_id TEXT,
  task_run_id TEXT,
  trace_id TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
  cache_miss_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  repair_attempted BOOLEAN NOT NULL DEFAULT false,
  repair_successful BOOLEAN NOT NULL DEFAULT false,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_provider_call_telemetry_provider ON provider_call_telemetry(provider);
CREATE INDEX IF NOT EXISTS idx_provider_call_telemetry_created ON provider_call_telemetry(created_at DESC);
