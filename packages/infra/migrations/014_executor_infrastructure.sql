-- 014_executor_infrastructure.sql
-- executor_nodes, service_instances, node_commands

CREATE TABLE IF NOT EXISTS executor_nodes (
  node_id TEXT PRIMARY KEY,
  node_kind TEXT NOT NULL DEFAULT 'executor',
  host_label TEXT NOT NULL DEFAULT '',
  node_url TEXT NOT NULL DEFAULT '',
  connect_modes TEXT NOT NULL DEFAULT 'agent_http',
  capabilities_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  health_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  load_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  resource_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  queue_depth INTEGER NOT NULL DEFAULT 0,
  active_task_count INTEGER NOT NULL DEFAULT 0,
  verified_at TIMESTAMPTZ,
  rollout_state TEXT NOT NULL DEFAULT 'active',
  last_heartbeat_at TIMESTAMPTZ,
  agent_key_hash TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_executor_nodes_kind ON executor_nodes(node_kind);
CREATE INDEX IF NOT EXISTS idx_executor_nodes_heartbeat ON executor_nodes(last_heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_executor_nodes_rollout ON executor_nodes(rollout_state);

CREATE TABLE IF NOT EXISTS service_instances (
  service_id TEXT PRIMARY KEY,
  service_kind TEXT NOT NULL,
  host_label TEXT NOT NULL DEFAULT '',
  bind_url TEXT NOT NULL DEFAULT '',
  public_url TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'active',
  capabilities_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  health_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  load_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  priority INTEGER NOT NULL DEFAULT 100,
  last_heartbeat_at TIMESTAMPTZ,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_service_instances_kind ON service_instances(service_kind);
CREATE INDEX IF NOT EXISTS idx_service_instances_heartbeat ON service_instances(last_heartbeat_at);

CREATE TABLE IF NOT EXISTS node_commands (
  command_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  command_name TEXT NOT NULL,
  requested_by TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  input_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_json JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_node_commands_node ON node_commands(node_id);
CREATE INDEX IF NOT EXISTS idx_node_commands_status ON node_commands(status);
