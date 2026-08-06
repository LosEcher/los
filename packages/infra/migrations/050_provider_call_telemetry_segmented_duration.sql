-- 050_provider_call_telemetry_segmented_duration.sql
-- PR #208 added per-segment timing (headers vs body) via the runtime
-- ensure*Store only; align the migration path so migrations-only and
-- ensure-only schemas agree (check-migration-drift gate).
ALTER TABLE provider_call_telemetry ADD COLUMN IF NOT EXISTS headers_duration_ms INTEGER;
ALTER TABLE provider_call_telemetry ADD COLUMN IF NOT EXISTS body_duration_ms INTEGER;
