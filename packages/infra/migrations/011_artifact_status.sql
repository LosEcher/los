-- Add artifact status lifecycle and confidence scoring.
-- Aligns with the confidence state machine: draft → candidate → reviewed → confirmed/rejected.
-- 'confirmed' requires human attestation (AI agents cannot write it).
--
-- Guarded: the artifacts table is created by migration 015 (after this seq).
-- On a fresh DB this migration runs before artifacts exists, so it no-ops;
-- migration 015 creates artifacts with these columns and idx_artifacts_status
-- already. On DBs where artifacts pre-existed (via ensure*Store) this adds
-- the columns/idempotently. CREATE TABLE IF NOT EXISTS does not guard ALTER
-- TABLE against a missing table, hence the to_regclass check.
DO $$
BEGIN
  IF to_regclass('public.artifacts') IS NOT NULL THEN
    ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft';
    ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5;
    CREATE INDEX IF NOT EXISTS idx_artifacts_status ON artifacts(status);
  END IF;
END $$;
