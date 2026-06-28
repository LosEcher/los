-- 024_memory_tables.sql
-- memory_compactions, observations
--
-- Canonical schema mirrors the runtime ensure*Store definitions in
-- packages/memory/src/core/compaction.ts and packages/memory/src/core/store.ts.
-- These tables previously existed only via ensure*Store (no migration), so a
-- fresh `db:migrate` did not create them. Idempotent.

CREATE TABLE IF NOT EXISTS memory_compactions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_spec_id TEXT,
  tenant_id TEXT,
  project_id TEXT,
  summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_patterns_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  procedural_candidates_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence NUMERIC NOT NULL DEFAULT 0,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Columns added by later ensure*Store revisions; mirrored here idempotently.
ALTER TABLE memory_compactions ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE memory_compactions ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE memory_compactions ADD COLUMN IF NOT EXISTS auto_trigger TEXT;
ALTER TABLE memory_compactions ADD COLUMN IF NOT EXISTS transcript_brief_json JSONB;

CREATE INDEX IF NOT EXISTS idx_memcomp_session
  ON memory_compactions(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memcomp_run_spec
  ON memory_compactions(run_spec_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memcomp_tenant_project
  ON memory_compactions(tenant_id, project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memcomp_checkpoint
  ON memory_compactions(session_id, auto_trigger, created_at DESC);

CREATE TABLE IF NOT EXISTS observations (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'note',
  tags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  content TEXT NOT NULL DEFAULT '',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  source TEXT NOT NULL DEFAULT 'user',
  session_id TEXT,
  tenant_id TEXT,
  project_id TEXT,
  user_id TEXT,
  node_id TEXT,
  request_id TEXT,
  trace_id TEXT,
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(content, '') || ' ' || coalesce(tags_json::text, ''))
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE observations ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE observations ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE observations ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE observations ADD COLUMN IF NOT EXISTS node_id TEXT;
ALTER TABLE observations ADD COLUMN IF NOT EXISTS request_id TEXT;
ALTER TABLE observations ADD COLUMN IF NOT EXISTS trace_id TEXT;

CREATE INDEX IF NOT EXISTS idx_obs_kind ON observations(kind);
CREATE INDEX IF NOT EXISTS idx_obs_source ON observations(source);
CREATE INDEX IF NOT EXISTS idx_obs_session ON observations(session_id);
CREATE INDEX IF NOT EXISTS idx_obs_tenant_project ON observations(tenant_id, project_id);
CREATE INDEX IF NOT EXISTS idx_obs_request ON observations(request_id);
CREATE INDEX IF NOT EXISTS idx_obs_trace ON observations(trace_id);
CREATE INDEX IF NOT EXISTS idx_obs_created ON observations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_obs_search ON observations USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_obs_tags_json ON observations USING GIN (tags_json);
CREATE INDEX IF NOT EXISTS idx_obs_scope ON observations ((metadata_json->>'scope'));
CREATE INDEX IF NOT EXISTS idx_obs_memory_layer ON observations ((metadata_json->>'memoryLayer'));
CREATE INDEX IF NOT EXISTS idx_obs_archived ON observations ((metadata_json->>'archived'));
CREATE INDEX IF NOT EXISTS idx_obs_metadata_entity ON observations USING GIN ((metadata_json -> 'entities'));
CREATE INDEX IF NOT EXISTS idx_obs_metadata_entity_type ON observations ((metadata_json ->> 'entityType'));

CREATE OR REPLACE FUNCTION touch_observations_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS obs_touch_updated_at ON observations;
CREATE TRIGGER obs_touch_updated_at
BEFORE UPDATE ON observations
FOR EACH ROW
EXECUTE FUNCTION touch_observations_updated_at();
