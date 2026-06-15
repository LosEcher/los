CREATE TABLE IF NOT EXISTS procedural_candidates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL DEFAULT 'info',
  rationale TEXT NOT NULL DEFAULT '',
  confidence NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  compaction_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  tenant_id TEXT,
  project_id TEXT,
  evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'procedural_candidates_status_chk'
      AND conrelid = 'procedural_candidates'::regclass
  ) THEN
    ALTER TABLE procedural_candidates
      ADD CONSTRAINT procedural_candidates_status_chk
      CHECK (status IN ('draft', 'review', 'approved', 'active', 'retired'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_proc_cand_status ON procedural_candidates(status);
CREATE INDEX IF NOT EXISTS idx_proc_cand_name ON procedural_candidates(name);
CREATE INDEX IF NOT EXISTS idx_proc_cand_compaction ON procedural_candidates(compaction_id);
CREATE INDEX IF NOT EXISTS idx_proc_cand_session ON procedural_candidates(session_id);
CREATE INDEX IF NOT EXISTS idx_proc_cand_tenant_project ON procedural_candidates(tenant_id, project_id);
