-- 049_run_specs_result_json.sql
-- Result payload for completed run specs (G2 subagent result persistence).
-- The ensure*Store schema adds the column idempotently; this migration keeps
-- the migrations-only DB structurally identical (migration drift gate).

ALTER TABLE run_specs ADD COLUMN IF NOT EXISTS result_json JSONB;
