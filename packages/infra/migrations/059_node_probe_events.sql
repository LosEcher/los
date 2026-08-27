-- 059_node_probe_events.sql
-- W-LOS-7 B6: node probe transition events (append-only).
-- Created by ensure*Store (executor-nodes.ts SCHEMA); this migration keeps the
-- migrations-only path in agreement (check-migration-drift gate). All statements
-- are IF NOT EXISTS so both paths converge idempotently.
CREATE TABLE IF NOT EXISTS node_probe_events (
  id BIGSERIAL PRIMARY KEY,
  node_id TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_node_probe_events_node ON node_probe_events(node_id, at DESC);
