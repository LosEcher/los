-- 058_fleet_resource_and_maintenance.sql
-- Komodo borrow P0 (2026-08-19): fleet_resource_state (hysteresis memory) and
-- node_maintenance_policy (maintenance windows) are created by ensure*Store in
-- fleet-resource-state.ts / node-maintenance-policy.ts; this migration keeps the
-- migrations-only path in agreement (check-migration-drift gate). All statements
-- are IF NOT EXISTS so both paths converge idempotently.
CREATE TABLE IF NOT EXISTS fleet_resource_state (
  node_id TEXT PRIMARY KEY,
  severities JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS node_maintenance_policy (
  node_id TEXT PRIMARY KEY,
  windows JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
