import { randomUUID } from 'node:crypto';
import { getDb } from '@los/infra/db';
import {
  ensureExecutorNodeStore,
  loadExecutorNode,
  upsertExecutorNode,
  type ExecutorNodeRecord,
} from './executor-nodes.js';

export type NodeCommandName = 'status' | 'probe' | 'drain' | 'promote' | 'restart' | 'upgrade' | 'rollback';
export type NodeCommandStatus = 'accepted' | 'running' | 'succeeded' | 'failed' | 'denied';

export interface NodeCommandRecord {
  commandId: string;
  nodeId: string;
  command: NodeCommandName;
  status: NodeCommandStatus;
  requestedBy?: string;
  requestId?: string;
  traceId?: string;
  targetVersion?: string;
  timeoutMs?: number;
  reason?: string;
  args: Record<string, unknown>;
  output: Record<string, unknown>;
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ExecuteNodeCommandInput {
  commandId?: string;
  nodeId: string;
  command: NodeCommandName;
  requestedBy?: string;
  requestId?: string;
  traceId?: string;
  targetVersion?: string;
  timeoutMs?: number;
  reason?: string;
  args?: Record<string, unknown>;
}

export interface ListNodeCommandsOptions {
  nodeId?: string;
  limit?: number;
}

const SCHEMA = `
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
`;

let _initialized = false;

export async function ensureNodeCommandStore(): Promise<void> {
  if (_initialized) return;
  const db = getDb();
  await db.exec(SCHEMA);
  _initialized = true;
}

export async function executeNodeCommand(input: ExecuteNodeCommandInput): Promise<NodeCommandRecord> {
  await ensureNodeCommandStore();
  await ensureExecutorNodeStore();

  const commandId = normalizeCommandId(input.commandId) ?? `node-command-${randomUUID()}`;
  const nodeId = requireString(input.nodeId, 'nodeId');
  const command = normalizeCommand(input.command);
  const created = await insertNodeCommand({
    ...input,
    commandId,
    nodeId,
    command,
    status: 'running',
  });

  try {
    const node = await loadExecutorNode(nodeId);
    if (!node) {
      return await completeNodeCommand(created.commandId, {
        status: 'failed',
        error: `executor node not found: ${nodeId}`,
      });
    }

    if (command === 'status') {
      return await completeNodeCommand(created.commandId, {
        status: 'succeeded',
        output: { node: summarizeNode(node) },
      });
    }

    if (command === 'drain') {
      const saved = await upsertExecutorNode({
        nodeId,
        status: 'draining',
        rolloutState: 'draining',
        rolloutMessage: normalizeOptionalString(input.reason) ?? 'drain requested',
        activeTaskCount: node.activeTaskCount,
      });
      return await completeNodeCommand(created.commandId, {
        status: 'succeeded',
        output: { node: summarizeNode(saved) },
      });
    }

    if (command === 'promote') {
      const saved = await upsertExecutorNode({
        nodeId,
        status: 'online',
        rolloutState: 'idle',
        rolloutMessage: normalizeOptionalString(input.reason) ?? 'promoted',
        activeTaskCount: node.activeTaskCount,
      });
      return await completeNodeCommand(created.commandId, {
        status: 'succeeded',
        output: { node: summarizeNode(saved) },
      });
    }

    if (command === 'upgrade') {
      const targetVersion = normalizeOptionalString(input.targetVersion);
      if (!targetVersion) {
        return await completeNodeCommand(created.commandId, {
          status: 'denied',
          error: 'targetVersion is required for upgrade',
        });
      }
      const saved = await upsertExecutorNode({
        nodeId,
        status: 'draining',
        targetVersion,
        rolloutState: 'draining',
        rolloutMessage: normalizeOptionalString(input.reason) ?? `upgrade requested: ${targetVersion}`,
        activeTaskCount: node.activeTaskCount,
      });
      return await completeNodeCommand(created.commandId, {
        status: 'accepted',
        output: {
          node: summarizeNode(saved),
          nextAction: 'run executor drain/restart/verify workflow on the target node',
        },
      });
    }

    return await completeNodeCommand(created.commandId, {
      status: 'denied',
      error: `${command} requires an executor-side command runner`,
    });
  } catch (error) {
    return await completeNodeCommand(created.commandId, {
      status: 'failed',
      error: errorMessage(error),
    });
  }
}

export async function listNodeCommands(options: ListNodeCommandsOptions = {}): Promise<NodeCommandRecord[]> {
  await ensureNodeCommandStore();
  const db = getDb();
  const rows = await db.query<NodeCommandRow>(
    `
    SELECT *
    FROM node_commands
    WHERE ($2::text IS NULL OR node_id = $2)
    ORDER BY created_at DESC
    LIMIT $1
  `,
    [normalizeLimit(options.limit), normalizeOptionalString(options.nodeId) ?? null],
  );
  return rows.rows.map(rowToNodeCommand);
}

export async function loadNodeCommand(commandId: string): Promise<NodeCommandRecord | null> {
  await ensureNodeCommandStore();
  const db = getDb();
  const rows = await db.query<NodeCommandRow>('SELECT * FROM node_commands WHERE command_id = $1', [requireString(commandId, 'commandId')]);
  return rows.rows[0] ? rowToNodeCommand(rows.rows[0]) : null;
}

async function insertNodeCommand(input: ExecuteNodeCommandInput & {
  commandId: string;
  nodeId: string;
  command: NodeCommandName;
  status: NodeCommandStatus;
}): Promise<NodeCommandRecord> {
  const db = getDb();
  const rows = await db.query<NodeCommandRow>(
    `
    INSERT INTO node_commands (
      command_id, node_id, command, status, requested_by, request_id, trace_id,
      target_version, timeout_ms, reason, args_json, output_json, started_at, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, '{}'::jsonb, now(), now())
    RETURNING *
  `,
    [
      input.commandId,
      input.nodeId,
      input.command,
      input.status,
      normalizeOptionalString(input.requestedBy) ?? null,
      normalizeOptionalString(input.requestId) ?? null,
      normalizeOptionalString(input.traceId) ?? null,
      normalizeOptionalString(input.targetVersion) ?? null,
      normalizePositiveInteger(input.timeoutMs) ?? null,
      normalizeOptionalString(input.reason) ?? null,
      JSON.stringify(input.args ?? {}),
    ],
  );
  return rowToNodeCommand(assertRow(rows.rows[0]));
}

async function completeNodeCommand(
  commandId: string,
  input: {
    status: NodeCommandStatus;
    output?: Record<string, unknown>;
    error?: string;
  },
): Promise<NodeCommandRecord> {
  const db = getDb();
  const rows = await db.query<NodeCommandRow>(
    `
    UPDATE node_commands
    SET status = $2,
        output_json = $3::jsonb,
        error = $4,
        completed_at = now(),
        updated_at = now()
    WHERE command_id = $1
    RETURNING *
  `,
    [
      commandId,
      input.status,
      JSON.stringify(input.output ?? {}),
      normalizeOptionalString(input.error) ?? null,
    ],
  );
  return rowToNodeCommand(assertRow(rows.rows[0]));
}

function summarizeNode(node: ExecutorNodeRecord): Record<string, unknown> {
  return {
    nodeId: node.nodeId,
    nodeKind: node.nodeKind,
    status: node.status,
    version: node.version ?? null,
    targetVersion: node.targetVersion ?? null,
    rolloutState: node.rolloutState ?? null,
    rolloutMessage: node.rolloutMessage ?? null,
    activeTaskCount: node.activeTaskCount,
    queueDepth: node.queueDepth,
    execution: node.execution,
  };
}

type NodeCommandRow = {
  command_id: string;
  node_id: string;
  command: NodeCommandName;
  status: NodeCommandStatus;
  requested_by: string | null;
  request_id: string | null;
  trace_id: string | null;
  target_version: string | null;
  timeout_ms: number | null;
  reason: string | null;
  args_json: unknown;
  output_json: unknown;
  error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
};

function rowToNodeCommand(row: NodeCommandRow): NodeCommandRecord {
  return {
    commandId: row.command_id,
    nodeId: row.node_id,
    command: normalizeCommand(row.command),
    status: normalizeStatus(row.status),
    requestedBy: row.requested_by ?? undefined,
    requestId: row.request_id ?? undefined,
    traceId: row.trace_id ?? undefined,
    targetVersion: row.target_version ?? undefined,
    timeoutMs: row.timeout_ms ?? undefined,
    reason: row.reason ?? undefined,
    args: normalizeJsonObject(row.args_json),
    output: normalizeJsonObject(row.output_json),
    error: row.error ?? undefined,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    startedAt: row.started_at ? toIsoString(row.started_at) : undefined,
    completedAt: row.completed_at ? toIsoString(row.completed_at) : undefined,
  };
}

function normalizeCommand(value: unknown): NodeCommandName {
  if (value === 'status' || value === 'probe' || value === 'drain' || value === 'promote' || value === 'restart' || value === 'upgrade' || value === 'rollback') {
    return value;
  }
  throw new Error(`unsupported node command: ${String(value)}`);
}

function normalizeStatus(value: unknown): NodeCommandStatus {
  if (value === 'accepted' || value === 'running' || value === 'succeeded' || value === 'failed' || value === 'denied') {
    return value;
  }
  return 'failed';
}

function normalizeCommandId(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return undefined;
  if (!/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new Error('commandId contains unsupported characters');
  }
  return normalized;
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
}

function requireString(value: unknown, name: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(1, Math.floor(value));
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(1, Math.floor(parsed));
  }
  return undefined;
}

function normalizeLimit(value: unknown): number {
  const parsed = normalizePositiveInteger(value);
  return parsed ? Math.min(parsed, 500) : 50;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('Node command write failed');
  return row;
}
