-- 034_dual_lease_fencing: monotonic fencing tokens for graph and run leases

ALTER TABLE task_runs
  ADD COLUMN IF NOT EXISTS lease_version BIGINT NOT NULL DEFAULT 0;

ALTER TABLE agent_tasks
  ADD COLUMN IF NOT EXISTS lease_version BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_task_runs_lease_fence
  ON task_runs(id, node_id, lease_version)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS idx_agent_tasks_lease_fence
  ON agent_tasks(id, claimed_by_node_id, lease_version)
  WHERE status = 'running';
