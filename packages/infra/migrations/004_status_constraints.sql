-- 004_status_constraints: enforce future legal status writes for runtime ledgers.
--
-- NOT VALID keeps startup/migration tolerant of historical dirty rows while
-- still rejecting new invalid writes. Use governance runtime-cleanup before
-- validating constraints on long-lived databases.

DO $$
BEGIN
  IF to_regclass('public.task_runs') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_constraint
       WHERE conname = 'task_runs_status_chk'
         AND conrelid = 'task_runs'::regclass
     ) THEN
    ALTER TABLE task_runs
      ADD CONSTRAINT task_runs_status_chk
      CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'blocked'))
      NOT VALID;
  END IF;

  IF to_regclass('public.run_specs') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_constraint
       WHERE conname = 'run_specs_status_chk'
         AND conrelid = 'run_specs'::regclass
     ) THEN
    ALTER TABLE run_specs
      ADD CONSTRAINT run_specs_status_chk
      CHECK (status IN ('created', 'running', 'succeeded', 'failed', 'cancelled', 'blocked'))
      NOT VALID;
  END IF;
END $$;
