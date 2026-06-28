-- 016_provider_evidence.sql
-- provider_compat_evidence, provider_promotion_decisions, provider_call_telemetry
-- Canonical schema mirrors ensure*Store (provider-compat-evidence.ts,
-- provider-promotion-decisions.ts, providers/telemetry.ts). Rewritten to match.

CREATE TABLE IF NOT EXISTS provider_compat_evidence (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT,
  probe_id TEXT NOT NULL,
  target_label TEXT NOT NULL,
  decision TEXT NOT NULL,
  passed BOOLEAN NOT NULL DEFAULT false,
  session_id TEXT,
  task_run_id TEXT,
  run_spec_id TEXT,
  trace_id TEXT,
  request_id TEXT,
  node_id TEXT,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_provider_compat_target ON provider_compat_evidence(provider, model, probe_id);
CREATE INDEX IF NOT EXISTS idx_provider_compat_decision ON provider_compat_evidence(decision);
CREATE INDEX IF NOT EXISTS idx_provider_compat_updated ON provider_compat_evidence(updated_at DESC);

CREATE TABLE IF NOT EXISTS provider_promotion_decisions (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  provider TEXT NOT NULL,
  model TEXT,
  probe_id TEXT NOT NULL,
  target_label TEXT NOT NULL,
  from_decision TEXT NOT NULL,
  to_decision TEXT NOT NULL,
  evidence_id TEXT,
  reason TEXT NOT NULL,
  actor TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_provider_promotion_target ON provider_promotion_decisions(provider, model, probe_id);
CREATE INDEX IF NOT EXISTS idx_provider_promotion_status ON provider_promotion_decisions(status);
CREATE INDEX IF NOT EXISTS idx_provider_promotion_updated ON provider_promotion_decisions(updated_at DESC);

CREATE TABLE IF NOT EXISTS provider_call_telemetry (
  id BIGSERIAL PRIMARY KEY,
  trace_id TEXT NOT NULL,
  session_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'POST',
  stream BOOLEAN NOT NULL DEFAULT false,
  request_payload_size INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  error_code TEXT,
  error_message TEXT,
  rate_limit_reset_ms INTEGER,
  usage_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pct_trace_id ON provider_call_telemetry(trace_id);
CREATE INDEX IF NOT EXISTS idx_pct_session_id ON provider_call_telemetry(session_id);
CREATE INDEX IF NOT EXISTS idx_pct_provider ON provider_call_telemetry(provider);
CREATE INDEX IF NOT EXISTS idx_pct_status ON provider_call_telemetry(status);
CREATE INDEX IF NOT EXISTS idx_pct_created ON provider_call_telemetry(created_at DESC);
