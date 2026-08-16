-- 056_verification_records_independence.sql
-- Roadmap R1 migration alignment: verification_records.independence column.
-- The ensure*Store SCHEMA in verification-records.ts declares this column;
-- this migration keeps the migrations-only path in agreement
-- (check-migration-drift gate). 'unknown' default keeps legacy rows explicit
-- as "not declared" — never inferred as independent.
ALTER TABLE verification_records ADD COLUMN IF NOT EXISTS independence TEXT NOT NULL DEFAULT 'unknown';
