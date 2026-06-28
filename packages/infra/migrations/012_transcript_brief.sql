-- 2026-06-18: transcript_brief_json column for structured transcript compression
--
-- Guarded: memory_compactions is created by migration 024 (after this seq).
-- On a fresh DB this runs before memory_compactions exists, so it no-ops;
-- migration 024 creates memory_compactions with transcript_brief_json already.
-- On DBs where memory_compactions pre-existed (via ensure*Store) this adds
-- the column idempotently.
DO $$
BEGIN
  IF to_regclass('public.memory_compactions') IS NOT NULL THEN
    ALTER TABLE memory_compactions
    ADD COLUMN IF NOT EXISTS transcript_brief_json JSONB;
  END IF;
END $$;
