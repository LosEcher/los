-- 014_executor_infrastructure.sql
-- executor_nodes, service_instances, node_commands
-- Canonical schema mirrors ensure*Store (executor-nodes.ts, service-instances.ts,
-- node-commands.ts). Rewritten to match — was drifted (stale columns/indexes).

CREATE TABLE IF NOT EXISTS executor_nodes (
  node_id TEXT PRIMARY KEY,
  node_kind TEXT NOT NULL DEFAULT 'executor',
  base_url TEXT,
  host_label TEXT,
  status TEXT NOT NULL,
  version TEXT,
  target_version TEXT,
  rollout_state TEXT NOT NULL DEFAULT 'idle',
  rollout_message TEXT,
  connect_modes_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  connect_config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  capacity_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  capabilities_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  verified_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  queue_depth INTEGER NOT NULL DEFAULT 0,
  active_task_count INTEGER NOT NULL DEFAULT 0,
  mesh_links_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_probe_at TIMESTAMPTZ,
  last_probe_error TEXT,
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_executor_nodes_status ON executor_nodes(status);
CREATE INDEX IF NOT EXISTS idx_executor_nodes_kind ON executor_nodes(node_kind);
CREATE INDEX IF NOT EXISTS idx_executor_nodes_heartbeat ON executor_nodes(last_heartbeat_at DESC);

CREATE TABLE IF NOT EXISTS service_instances (
  service_id TEXT PRIMARY KEY,
  service_kind TEXT NOT NULL DEFAULT 'gateway',
  node_id TEXT,
  host_label TEXT,
  bind_url TEXT,
  public_url TEXT,
  status TEXT NOT NULL DEFAULT 'offline',
  role TEXT NOT NULL DEFAULT 'active',
  version TEXT,
  target_version TEXT,
  rollout_state TEXT NOT NULL DEFAULT 'idle',
  rollout_message TEXT,
  capabilities_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  health_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  load_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  priority INTEGER NOT NULL DEFAULT 100,
  region TEXT,
  last_probe_at TIMESTAMPTZ,
  last_probe_error TEXT,
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_service_instances_kind ON service_instances(service_kind);
CREATE INDEX IF NOT EXISTS idx_service_instances_status ON service_instances(status);
CREATE INDEX IF NOT EXISTS idx_service_instances_heartbeat ON service_instances(last_heartbeat_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_instances_priority ON service_instances(priority);

CREATE TABLE IF NOT EXISTS node_commands (
  command_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  command TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_by TEXT,
  request_id TEXT,
  trace_id TEXT,
  target_version TEXT,
  timeout_ms INTEGER,
  reason TEXT,
  args_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_node_commands_node_id ON node_commands(node_id);
CREATE INDEX IF NOT EXISTS idx_node_commands_status ON node_commands(status);
CREATE INDEX IF NOT EXISTS idx_node_commands_created ON node_commands(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_node_commands_request_id ON node_commands(request_id);
CREATE INDEX IF NOT EXISTS idx_node_commands_trace_id ON node_commands(trace_id);
