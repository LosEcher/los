-- 006_procedural_candidates.sql
-- Creates standalone procedural_candidates table per ADR 0020 section 4.
-- Previously candidates were stored inline in memory_compactions.procedural_candidates_json JSONB.

CREATE TABLE IF NOT EXISTS procedural_candidates (
  id TEXT PRIMARY KEY,
  compaction_id TEXT NOT NULL REFERENCES memory_compactions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  severity TEXT DEFAULT 'info',
  rationale TEXT DEFAULT '',
  confidence NUMERIC DEFAULT 0,
  status TEXT DEFAULT 'draft',
  supporting_session_ids TEXT[] DEFAULT '{}',
  rejected_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_procedural_candidates_compaction ON procedural_candidates(compaction_id);
CREATE INDEX IF NOT EXISTS idx_procedural_candidates_status ON procedural_candidates(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_procedural_candidates_name ON procedural_candidates(name, status);
