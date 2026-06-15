CREATE TABLE IF NOT EXISTS static_graph_baselines (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  graph_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  node_count INTEGER NOT NULL DEFAULT 0,
  edge_count INTEGER NOT NULL DEFAULT 0,
  captured_by TEXT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  previous_baseline_id TEXT,
  tenant_id TEXT,
  project_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sgb_label ON static_graph_baselines(label);
CREATE INDEX IF NOT EXISTS idx_sgb_captured_at ON static_graph_baselines(captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_sgb_tenant_project ON static_graph_baselines(tenant_id, project_id);
