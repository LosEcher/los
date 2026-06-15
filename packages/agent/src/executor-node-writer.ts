import { getDb } from '@los/infra/db';
import {
  normalizeOptionalString,
  normalizeRolloutState,
  normalizeInteger,
  jsonOrNull,
  toIsoString,
} from './executor-node-utils.js';
import type { ExecutorNodeKind, ExecutorNodeConnectMode, ExecutorNodeRolloutState, ExecutorNodeStatus } from './executor-nodes.js';

export type ExecutorNodeRow = {
  node_id: string;
  node_kind: ExecutorNodeKind;
  base_url: string | null;
  host_label: string | null;
  status: ExecutorNodeStatus;
  version: string | null;
  target_version: string | null;
  rollout_state: string | null;
  rollout_message: string | null;
  connect_modes_json: unknown;
  connect_config_json: unknown;
  capacity_json: unknown;
  capabilities_json: unknown;
  verified_json: unknown;
  queue_depth: number | string;
  active_task_count: number | string;
  mesh_links_json: unknown;
  last_probe_at: Date | string | null;
  last_probe_error: string | null;
  last_heartbeat_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
};

export async function writeExecutorNode(
  nodeId: string,
  input: {
    nodeKind?: ExecutorNodeKind;
    baseUrl?: string;
    hostLabel?: string;
    status?: ExecutorNodeStatus;
    version?: string;
    targetVersion?: string;
    rolloutState?: ExecutorNodeRolloutState;
    rolloutMessage?: string;
    connectModes?: ExecutorNodeConnectMode[];
    connectConfig?: Record<string, unknown>;
    capacity?: Record<string, unknown>;
    capabilities?: Record<string, unknown>;
    verified?: Record<string, unknown>;
    queueDepth?: number;
    activeTaskCount?: number;
    meshLinks?: Array<Record<string, unknown>>;
    lastProbeAt?: Date | string | null;
    lastProbeError?: string | null;
    touchHeartbeat: boolean;
  },
): Promise<ExecutorNodeRow[]> {
  const db = getDb();
  const hasLastProbeError = Object.prototype.hasOwnProperty.call(input, 'lastProbeError');
  const rows = await db.query<ExecutorNodeRow>(
    `
    INSERT INTO executor_nodes (
      node_id, node_kind, base_url, host_label, status, version,
      target_version, rollout_state, rollout_message,
      connect_modes_json, connect_config_json, capacity_json, capabilities_json, verified_json,
      queue_depth, active_task_count, mesh_links_json, last_probe_at, last_probe_error,
      last_heartbeat_at, updated_at
    )
    VALUES (
      $1,
      COALESCE($2, 'executor'),
      $3,
      $4,
      COALESCE($5, 'offline'),
      $6,
      $7,
      COALESCE($8, 'idle'),
      $9,
      COALESCE($10::jsonb, '[]'::jsonb),
      COALESCE($11::jsonb, '{}'::jsonb),
      COALESCE($12::jsonb, '{}'::jsonb),
      COALESCE($13::jsonb, '{}'::jsonb),
      COALESCE($14::jsonb, '{}'::jsonb),
      COALESCE($15::integer, 0),
      COALESCE($16::integer, 0),
      COALESCE($17::jsonb, '[]'::jsonb),
      $18::timestamptz,
      $19,
      now(),
      now()
    )
    ON CONFLICT (node_id) DO UPDATE
      SET node_kind = COALESCE($2, executor_nodes.node_kind),
          base_url = COALESCE($3, executor_nodes.base_url),
          host_label = COALESCE($4, executor_nodes.host_label),
          status = COALESCE($5, executor_nodes.status),
          version = COALESCE($6, executor_nodes.version),
          target_version = COALESCE($7, executor_nodes.target_version),
          rollout_state = COALESCE($8, executor_nodes.rollout_state),
          rollout_message = COALESCE($9, executor_nodes.rollout_message),
          connect_modes_json = COALESCE($10::jsonb, executor_nodes.connect_modes_json),
          connect_config_json = COALESCE($11::jsonb, executor_nodes.connect_config_json),
          capacity_json = COALESCE($12::jsonb, executor_nodes.capacity_json),
          capabilities_json = COALESCE($13::jsonb, executor_nodes.capabilities_json),
          verified_json = COALESCE($14::jsonb, executor_nodes.verified_json),
          queue_depth = COALESCE($15::integer, executor_nodes.queue_depth),
          active_task_count = COALESCE($16::integer, executor_nodes.active_task_count),
          mesh_links_json = COALESCE($17::jsonb, executor_nodes.mesh_links_json),
          last_probe_at = COALESCE($18::timestamptz, executor_nodes.last_probe_at),
          last_probe_error = CASE WHEN $21::boolean THEN $19 ELSE executor_nodes.last_probe_error END,
          last_heartbeat_at = CASE WHEN $20::boolean THEN now() ELSE executor_nodes.last_heartbeat_at END,
          updated_at = now()
    RETURNING *
  `,
    [
      nodeId,
      input.nodeKind ?? null,
      input.baseUrl ?? null,
      input.hostLabel ?? null,
      input.status ?? null,
      input.version ?? null,
      input.targetVersion ?? null,
      input.rolloutState ?? null,
      input.rolloutMessage ?? null,
      jsonOrNull(input.connectModes),
      jsonOrNull(input.connectConfig),
      jsonOrNull(input.capacity),
      jsonOrNull(input.capabilities),
      jsonOrNull(input.verified),
      input.queueDepth === undefined ? null : normalizeInteger(input.queueDepth),
      input.activeTaskCount === undefined ? null : normalizeInteger(input.activeTaskCount),
      jsonOrNull(input.meshLinks),
      input.lastProbeAt ? toIsoString(input.lastProbeAt) : null,
      input.lastProbeError ?? null,
      input.touchHeartbeat,
      hasLastProbeError,
    ],
  );
  return rows.rows;
}
