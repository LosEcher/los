-- 057_fleet_config_tables.sql
-- Roadmap fleet node-recovery alignment: fleet_alert_config / fleet_repair_config /
-- node_recovery_policy tables are created by ensure*Store in fleet-alert-config.ts,
-- fleet-repair-config.ts, node-recovery-policy.ts; this migration keeps the
-- migrations-only path in agreement (check-migration-drift gate). All statements
-- are IF NOT EXISTS so both paths converge idempotently.
CREATE TABLE IF NOT EXISTS fleet_alert_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  consecutive_ticks INTEGER,
  cooldown_ms INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fleet_repair_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  auto_repair BOOLEAN,
  cooldown_ms INTEGER,
  max_consecutive_failures INTEGER,
  quorum_threshold REAL,
  restart_unhealthy BOOLEAN,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS node_recovery_policy (
  node_id TEXT PRIMARY KEY,
  supervisor TEXT NOT NULL DEFAULT 'os_supervisor',
  repair_enabled BOOLEAN,
  cooldown_ms INTEGER,
  max_consecutive_failures INTEGER,
  quorum_threshold REAL,
  restart_unhealthy BOOLEAN,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
