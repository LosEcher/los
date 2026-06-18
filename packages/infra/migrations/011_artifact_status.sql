-- Add artifact status lifecycle and confidence scoring.
-- Aligns with the confidence state machine: draft → candidate → reviewed → confirmed/rejected.
-- 'confirmed' requires human attestation (AI agents cannot write it).
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5;
CREATE INDEX IF NOT EXISTS idx_artifacts_status ON artifacts(status);
