import { getDb } from '@los/infra/db';
import {
  normalizeOptionalString,
  normalizeRolloutState,
  normalizeInteger,
  normalizeStringArray,
  normalizeJsonObject,
  normalizeJsonArray,
  jsonOrNull,
  preferredExecutorMode,
  readVerification,
  buildHeartbeatVerification,
  toIsoString,
  assertRow,
} from './executor-node-utils.js';

const EXECUTOR_NODE_STALE_MS = 60_000;

export type ExecutorNodeStatus = 'online' | 'draining' | 'offline';
export type ExecutorNodeKind = 'executor' | 'ssh_target' | 'ingress' | 'proxy';
export type ResourceClass = 'control' | 'standard_executor' | 'constrained_executor';
export type ExecutorNodeRolloutState = 'idle' | 'draining' | 'upgrading' | 'verifying' | 'failed';

export type ExecutorNodeConnectMode =
  | 'agent_http'
  | 'agent_http_ndjson'
  | 'http_health'
  | 'direct_ssh'
  | 'tailscale_ssh'
  | 'tailscale_native_ssh'
  | 'cf_tunnel_http'
  | 'cf_tunnel_ssh'
  | 'socks5';

export interface ExecutorNodeRecord {
  nodeId: string;
  nodeKind: ExecutorNodeKind;
  resourceClass?: ResourceClass;
  baseUrl?: string;
  hostLabel?: string;
  status: ExecutorNodeStatus;
  version?: string;
  targetVersion?: string;
  rolloutState?: ExecutorNodeRolloutState;
  rolloutMessage?: string;
  connectModes: string[];
  connectConfig: Record<string, unknown>;
  capacity: ExecutorNodeCapacity;
  capabilities: Record<string, unknown>;
  verified: Record<string, unknown>;
  queueDepth: number;
  activeTaskCount: number;
  meshLinks: Array<Record<string, unknown>>;
  lastProbeAt?: string;
  lastProbeError?: string;
  lastHeartbeatAt: string;
  createdAt: string;
  updatedAt: string;
  execution: ExecutorNodeExecutionState;
}

export interface ExecutorNodeCapacity {
  pid?: number;
  arch?: string;
  platform?: string;
  memoryTotalMb?: number;
  memoryAvailableMb?: number;
  swapTotalMb?: number;
  swapUsedMb?: number;
  diskFreeGb?: number;
  psiMemorySome?: number;
  psiMemoryFull?: number;
  psiIoSome?: number;
  psiIoFull?: number;
}
export interface ExecutorNodeExecutionState {
  candidate: boolean;
  mode?: string;
  blockers: string[];
  warnings: string[];
}

export interface ExecutorNodeHeartbeatInput {
  nodeId: string;
  nodeKind?: ExecutorNodeKind;
  resourceClass?: ResourceClass;
  baseUrl?: string;
  hostLabel?: string;
  status?: ExecutorNodeStatus;
  version?: string;
  targetVersion?: string;
  rolloutState?: ExecutorNodeRolloutState;
  rolloutMessage?: string;
  connectModes?: ExecutorNodeConnectMode[];
  connectConfig?: Record<string, unknown>;
  capacity?: Partial<ExecutorNodeCapacity>;
  capabilities?: Record<string, unknown>;
  queueDepth?: number;
  activeTaskCount?: number;
  meshLinks?: Array<Record<string, unknown>>;
}

export interface ExecutorNodeUpsertInput {
  nodeId: string;
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
}

export interface ExecutorNodeProbeInput {
  nodeId: string;
  status?: ExecutorNodeStatus;
  verified?: Record<string, unknown>;
  connectModes?: ExecutorNodeConnectMode[];
  connectConfig?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  queueDepth?: number;
  activeTaskCount?: number;
  meshLinks?: Array<Record<string, unknown>>;
  lastProbeAt?: Date | string;
  lastProbeError?: string | null;
}

const SCHEMA = `
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

ALTER TABLE executor_nodes ADD COLUMN IF NOT EXISTS node_kind TEXT NOT NULL DEFAULT 'executor';
ALTER TABLE executor_nodes ADD COLUMN IF NOT EXISTS target_version TEXT;
ALTER TABLE executor_nodes ADD COLUMN IF NOT EXISTS rollout_state TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE executor_nodes ADD COLUMN IF NOT EXISTS rollout_message TEXT;
ALTER TABLE executor_nodes ADD COLUMN IF NOT EXISTS connect_modes_json JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE executor_nodes ADD COLUMN IF NOT EXISTS connect_config_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE executor_nodes ADD COLUMN IF NOT EXISTS capabilities_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE executor_nodes ADD COLUMN IF NOT EXISTS verified_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE executor_nodes ADD COLUMN IF NOT EXISTS queue_depth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE executor_nodes ADD COLUMN IF NOT EXISTS active_task_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE executor_nodes ADD COLUMN IF NOT EXISTS mesh_links_json JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE executor_nodes ADD COLUMN IF NOT EXISTS last_probe_at TIMESTAMPTZ;
ALTER TABLE executor_nodes ADD COLUMN IF NOT EXISTS last_probe_error TEXT;

CREATE INDEX IF NOT EXISTS idx_executor_nodes_status ON executor_nodes(status);
CREATE INDEX IF NOT EXISTS idx_executor_nodes_kind ON executor_nodes(node_kind);
CREATE INDEX IF NOT EXISTS idx_executor_nodes_heartbeat ON executor_nodes(last_heartbeat_at DESC);
`;

let _initialized = false;

export async function ensureExecutorNodeStore(): Promise<void> {
  if (_initialized) return;
  const db = getDb();
  await db.exec(SCHEMA);
  _initialized = true;
}

export async function upsertExecutorNodeHeartbeat(input: ExecutorNodeHeartbeatInput): Promise<ExecutorNodeRecord> {
  await ensureExecutorNodeStore();
  const existing = await loadExecutorNode(input.nodeId);
  const connectModes = mergeStringLists(existing?.connectModes, input.connectModes ?? ['agent_http']);
  return writeExecutorNode(input.nodeId, {
    touchHeartbeat: true,
    nodeKind: input.nodeKind ?? 'executor',
    baseUrl: normalizeOptionalString(input.baseUrl),
    hostLabel: normalizeOptionalString(input.hostLabel),
    status: resolveHeartbeatStatus(existing?.status, input.status),
    version: normalizeOptionalString(input.version),
    targetVersion: normalizeOptionalString(input.targetVersion),
    rolloutState: normalizeRolloutState(input.rolloutState),
    rolloutMessage: normalizeOptionalString(input.rolloutMessage),
    connectModes,
    connectConfig: mergeObjects(existing?.connectConfig, input.connectConfig),
    capacity: mergeObjects(existing?.capacity as Record<string, unknown> | undefined, input.capacity as Record<string, unknown> | undefined) as Record<string, unknown>,
    capabilities: mergeObjects(existing?.capabilities, input.capabilities),
    verified: buildHeartbeatVerification(existing?.verified ?? {}, connectModes, input),
    queueDepth: input.queueDepth ?? 0,
    activeTaskCount: input.activeTaskCount ?? 0,
    meshLinks: input.meshLinks ?? existing?.meshLinks ?? [],
  });
}

export async function listExecutorNodes(limit = 50): Promise<ExecutorNodeRecord[]> {
  await ensureExecutorNodeStore();
  const db = getDb();
  const rows = await db.query<ExecutorNodeRow>(
    'SELECT * FROM executor_nodes ORDER BY last_heartbeat_at DESC, updated_at DESC LIMIT $1',
    [limit],
  );
  return rows.rows.map(rowToExecutorNode);
}

export async function loadExecutorNode(nodeId: string): Promise<ExecutorNodeRecord | null> {
  await ensureExecutorNodeStore();
  const db = getDb();
  const rows = await db.query<ExecutorNodeRow>('SELECT * FROM executor_nodes WHERE node_id = $1', [nodeId]);
  const row = rows.rows[0];
  return row ? rowToExecutorNode(row) : null;
}

export async function upsertExecutorNode(input: ExecutorNodeUpsertInput): Promise<ExecutorNodeRecord> {
  await ensureExecutorNodeStore();
  return writeExecutorNode(input.nodeId, {
    touchHeartbeat: false,
    nodeKind: input.nodeKind,
    baseUrl: normalizeOptionalString(input.baseUrl),
    hostLabel: normalizeOptionalString(input.hostLabel),
    status: input.status,
    version: normalizeOptionalString(input.version),
    targetVersion: normalizeOptionalString(input.targetVersion),
    rolloutState: normalizeRolloutState(input.rolloutState),
    rolloutMessage: normalizeOptionalString(input.rolloutMessage),
    connectModes: input.connectModes,
    connectConfig: input.connectConfig,
    capacity: input.capacity,
    capabilities: input.capabilities,
    verified: input.verified,
    queueDepth: input.queueDepth,
    activeTaskCount: input.activeTaskCount,
    meshLinks: input.meshLinks,
    lastProbeAt: input.lastProbeAt ?? null,
    lastProbeError: input.lastProbeError ?? null,
  });
}

export async function recordExecutorNodeProbe(input: ExecutorNodeProbeInput): Promise<ExecutorNodeRecord> {
  await ensureExecutorNodeStore();
  return writeExecutorNode(input.nodeId, {
    touchHeartbeat: false,
    status: input.status ?? 'online',
    verified: input.verified ?? {},
    connectModes: input.connectModes,
    connectConfig: input.connectConfig,
    capabilities: input.capabilities,
    queueDepth: input.queueDepth,
    activeTaskCount: input.activeTaskCount,
    meshLinks: input.meshLinks,
    lastProbeAt: input.lastProbeAt ?? new Date(),
    lastProbeError: input.lastProbeError ?? null,
  });
}

type ExecutorNodeRow = {
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

function rowToExecutorNode(row: ExecutorNodeRow): ExecutorNodeRecord {
  const record = {
    nodeId: row.node_id,
    nodeKind: row.node_kind,
    baseUrl: row.base_url ?? undefined,
    hostLabel: row.host_label ?? undefined,
    status: row.status,
    version: row.version ?? undefined,
    targetVersion: row.target_version ?? undefined,
    rolloutState: normalizeRolloutState(row.rollout_state) ?? undefined,
    rolloutMessage: row.rollout_message ?? undefined,
    connectModes: normalizeStringArray(row.connect_modes_json),
    connectConfig: normalizeJsonObject(row.connect_config_json),
    capacity: normalizeJsonObject(row.capacity_json),
    capabilities: normalizeJsonObject(row.capabilities_json),
    verified: normalizeJsonObject(row.verified_json),
    queueDepth: normalizeInteger(row.queue_depth),
    activeTaskCount: normalizeInteger(row.active_task_count),
    meshLinks: normalizeJsonArray(row.mesh_links_json),
    lastProbeAt: row.last_probe_at ? toIsoString(row.last_probe_at) : undefined,
    lastProbeError: row.last_probe_error ?? undefined,
    lastHeartbeatAt: toIsoString(row.last_heartbeat_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
  return {
    ...record,
    execution: evaluateExecutorNode(record),
  };
}

export function evaluateExecutorNode(node: Omit<ExecutorNodeRecord, 'execution'>): ExecutorNodeExecutionState {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const mode = preferredExecutorMode(node.connectModes);

  if (node.status !== 'online') {
    blockers.push(`status:${node.status}`);
  }
  if (isHeartbeatStale(node.lastHeartbeatAt)) {
    blockers.push('heartbeat:stale');
  }
  if (node.nodeKind !== 'executor') {
    blockers.push(`node_kind:${node.nodeKind}`);
  }
  if (!mode) {
    blockers.push('connect_mode:missing_agent_http');
  }
  if (node.capabilities.run_agent !== true) {
    blockers.push('capability:run_agent_missing');
  }

  const verifiedMode = mode ? readVerification(node.verified, mode) : null;
  if (mode && verifiedMode !== true) {
    blockers.push(`verification:${mode}:not_confirmed`);
  }

  // Resource class checks — constrained executors are online but limited
  if (node.resourceClass === 'constrained_executor') {
    warnings.push('resource_class:constrained_executor');
    if (node.capabilities.heavy_task_safe !== true) {
      warnings.push('capability:heavy_task_safe_false');
    }
    if (node.capabilities.deploy_safe !== true) {
      warnings.push('capability:deploy_safe_false');
    }
  }

  // Memory pressure warnings
  if (node.capacity.memoryAvailableMb !== undefined && node.capacity.memoryTotalMb !== undefined) {
    const ratio = node.capacity.memoryAvailableMb / node.capacity.memoryTotalMb;
    if (ratio < 0.1) {
      warnings.push('resource:memory_pressure');
    }
  }

  if (node.capacity.diskFreeGb !== undefined && node.capacity.diskFreeGb < 1) {
    blockers.push('resource:disk_full');
  }

  if (node.connectModes.includes('socks5') && node.nodeKind !== 'executor') {
    warnings.push('proxy_egress_only');
  }
  if (node.connectModes.some(item => item.startsWith('cf_tunnel')) && node.nodeKind !== 'executor') {
    warnings.push('ingress_only');
  }
  if (node.connectModes.some(item => item.startsWith('tailscale')) && node.nodeKind !== 'executor') {
    warnings.push('remote_access_only');
  }

  return {
    candidate: blockers.length === 0,
    mode,
    blockers,
    warnings,
  };
}

function isHeartbeatStale(value: string | undefined): boolean {
  if (!value) return true;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return true;
  return Date.now() - timestamp > EXECUTOR_NODE_STALE_MS;
}

/**
 * Sort executor candidates by load: lower queue depth → lower active task count → higher capacity → fresher heartbeat.
 * Preferred nodeId (if specified) always comes first.
 */
export function sortExecutorCandidates(
  candidates: ExecutorNodeRecord[],
  preferredNodeId?: string,
): ExecutorNodeRecord[] {
  const sorted = [...candidates].sort((a, b) => {
    // Preferred node always first
    if (preferredNodeId) {
      if (a.nodeId === preferredNodeId && b.nodeId !== preferredNodeId) return -1;
      if (b.nodeId === preferredNodeId && a.nodeId !== preferredNodeId) return 1;
    }
    // Lower queue depth first
    if (a.queueDepth !== b.queueDepth) return a.queueDepth - b.queueDepth;
    // Lower active task count first
    if (a.activeTaskCount !== b.activeTaskCount) return a.activeTaskCount - b.activeTaskCount;
    // Higher capacity first (approximate by presence)
    const aCap = Object.keys(a.capacity).length;
    const bCap = Object.keys(b.capacity).length;
    if (aCap !== bCap) return bCap - aCap;
    // Fresher heartbeat first
    return (b.lastHeartbeatAt ?? '').localeCompare(a.lastHeartbeatAt ?? '');
  });
  return sorted;
}

function resolveHeartbeatStatus(
  existing: ExecutorNodeStatus | undefined,
  requested: ExecutorNodeStatus | undefined,
): ExecutorNodeStatus {
  if (requested) return requested;
  return existing === 'draining' ? 'draining' : 'online';
}

function mergeStringLists(existing: readonly string[] | undefined, incoming: readonly string[]): ExecutorNodeConnectMode[] {
  const merged = [...(existing ?? []), ...incoming]
    .map(item => normalizeOptionalString(item))
    .filter((item): item is ExecutorNodeConnectMode => Boolean(item));
  return [...new Set(merged)];
}

function mergeObjects(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    ...(existing ?? {}),
    ...(incoming ?? {}),
  };
}

async function writeExecutorNode(
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
): Promise<ExecutorNodeRecord> {
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
  return rowToExecutorNode(assertRow(rows.rows[0]));
}
