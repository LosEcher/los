-- 025_post_run_specs_forward_refs.sql
-- Forward references that could not be resolved earlier in migration order:
--   1. run_specs_status_chk — migration 004 adds status CHECK constraints for
--      task_runs (exists at 004) and run_specs (created at 013, after 004).
--      On a fresh DB 004 skips run_specs_status_chk because the table does not
--      exist yet; this migration adds it now that run_specs exists.
--   2. dead_letter_events.run_spec_id FK — migration 010 creates
--      dead_letter_events (seq 010) but cannot inline-reference run_specs
--      (created at 013). This migration adds the FK now that run_specs exists.
-- Idempotent and safe on DBs where these were already added (by 004/010 on
-- pre-ensure DBs, or by ensure*Store).

DO $$
BEGIN
  IF to_regclass('public.run_specs') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'run_specs_status_chk'
         AND conrelid = to_regclass('public.run_specs')
     ) THEN
    ALTER TABLE run_specs
      ADD CONSTRAINT run_specs_status_chk
      CHECK (status IN ('created', 'running', 'succeeded', 'failed', 'cancelled', 'blocked'))
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.dead_letter_events') IS NOT NULL
     AND to_regclass('public.run_specs') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'dead_letter_events_run_spec_id_fkey'
         AND conrelid = to_regclass('public.dead_letter_events')
     ) THEN
    ALTER TABLE dead_letter_events
      ADD CONSTRAINT dead_letter_events_run_spec_id_fkey
      FOREIGN KEY (run_spec_id) REFERENCES run_specs(id) ON DELETE SET NULL;
  END IF;
END $$;
