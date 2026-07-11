CREATE TABLE IF NOT EXISTS feed_analysis_dispatches (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'local',
  project_id TEXT NOT NULL DEFAULT 'los',
  source_system TEXT NOT NULL,
  source_job_id TEXT NOT NULL,
  source_session_id TEXT,
  delivery_mode TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  bundle_version TEXT,
  bundle_id TEXT,
  input_digest TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  requested_outputs_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  policy_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  callback_profile_id TEXT,
  material_json JSONB,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  run_spec_id TEXT,
  task_run_id TEXT,
  session_id TEXT,
  trace_id TEXT,
  status TEXT NOT NULL DEFAULT 'accepted',
  result_available BOOLEAN NOT NULL DEFAULT false,
  error_code TEXT,
  error_message TEXT,
  sequence INTEGER NOT NULL DEFAULT 0,
  retention_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (tenant_id, project_id, source_system, source_job_id),
  CHECK (delivery_mode IN ('delivery_only', 'result_returning')),
  CHECK (status IN ('accepted', 'queued', 'processing', 'result_ready', 'completed', 'failed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_feed_analysis_dispatch_status
  ON feed_analysis_dispatches(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_feed_analysis_dispatch_run
  ON feed_analysis_dispatches(run_spec_id);

CREATE TABLE IF NOT EXISTS feed_analysis_results (
  dispatch_id TEXT PRIMARY KEY REFERENCES feed_analysis_dispatches(id) ON DELETE CASCADE,
  schema_version TEXT NOT NULL,
  summary TEXT NOT NULL,
  citations_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  warnings_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  workflow_id TEXT NOT NULL,
  workflow_version TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  usage_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_json JSONB NOT NULL,
  result_digest TEXT NOT NULL,
  validated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feed_analysis_artifacts (
  artifact_id TEXT PRIMARY KEY,
  dispatch_id TEXT NOT NULL REFERENCES feed_analysis_dispatches(id) ON DELETE CASCADE,
  artifact_kind TEXT NOT NULL,
  target_platform TEXT,
  locale TEXT NOT NULL,
  title TEXT,
  title_candidates_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  body TEXT NOT NULL,
  hashtags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  structured_payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  citation_refs_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  workflow_id TEXT NOT NULL,
  workflow_version TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feed_analysis_artifact_dispatch
  ON feed_analysis_artifacts(dispatch_id, created_at);

CREATE TABLE IF NOT EXISTS feed_analysis_callback_events (
  event_id TEXT PRIMARY KEY,
  dispatch_id TEXT NOT NULL REFERENCES feed_analysis_dispatches(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  event_version TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  payload_digest TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dispatch_id, sequence)
);

CREATE TABLE IF NOT EXISTS feed_analysis_callback_deliveries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES feed_analysis_callback_events(event_id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_http_status INTEGER,
  last_error TEXT,
  delivered_at TIMESTAMPTZ,
  dead_lettered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, profile_id),
  CHECK (status IN ('pending', 'delivering', 'delivered', 'dead_letter'))
);

CREATE INDEX IF NOT EXISTS idx_feed_analysis_callback_due
  ON feed_analysis_callback_deliveries(next_attempt_at, created_at)
  WHERE status = 'pending';
