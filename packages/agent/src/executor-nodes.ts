import { getDb } from '@los/infra/db';
import {
  normalizeOptionalString,
  normalizeRolloutState,
  normalizeInteger,
  normalizeStringArray,
  normalizeJsonObject,
  normalizeJsonArray,
  preferredExecutorMode,
  readVerification,
  buildHeartbeatVerification,
  toIsoString,
  assertRow,
} from './executor-node-utils.js';
import { writeExecutorNode as execWriteNode, type ExecutorNodeRow } from './executor-node-writer.js';

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

export interface MarkStaleExecutorNodesOfflineResult {
  updated: ExecutorNodeRecord[];
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

export async function markStaleExecutorNodesOffline(
  staleMs = EXECUTOR_NODE_STALE_MS,
): Promise<MarkStaleExecutorNodesOfflineResult> {
  await ensureExecutorNodeStore();
  const db = getDb();
  const rows = await db.query<ExecutorNodeRow>(
    `
    UPDATE executor_nodes
       SET status = 'offline',
           rollout_message = COALESCE(rollout_message, 'heartbeat stale; marked offline by gateway maintenance'),
           updated_at = now()
     WHERE status = 'online'
       AND last_heartbeat_at < now() - ($1::integer * interval '1 millisecond')
     RETURNING *
    `,
    [Math.max(0, Math.floor(staleMs))],
  );
  return { updated: rows.rows.map(rowToExecutorNode) };
}

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

export { type ExecutorNodeRow } from './executor-node-writer.js';

async function writeExecutorNode(
  nodeId: string,
  input: Parameters<typeof execWriteNode>[1],
): Promise<ExecutorNodeRecord> {
  const rows = await execWriteNode(nodeId, input);
  return rowToExecutorNode(assertRow(rows[0]));
}
