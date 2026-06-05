/**
 * @los/agent/run-specs — Durable execution contracts.
 *
 * A run_spec captures the COMPLETE execution contract for an agent run:
 * prompt, provider, model, tool mode, workspace, etc.
 *
 * task_runs represent ATTEMPTS to fulfill a run_spec.
 * One run_spec can have multiple task_runs (for retries, failover, replay).
 */

import { getDb } from '@los/infra/db';
import {
  normalizeRunContractMetadata,
  type RunContractMetadata,
  type RunContractMetadataInput,
} from './run-contract.js';
import { seedVerificationRequirementsForRunSpec } from './verification-records.js';

// ── Types ───────────────────────────────────────────────

export type RunSpecStatus = 'created' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface RunSpecRecord {
  id: string;
  sessionId: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  nodeId?: string;
  requestId?: string;
  traceId?: string;
  prompt: string;
  systemPrompt?: string;
  provider?: string;
  model?: string;
  modelSettings: Record<string, unknown>;
  workspaceRoot: string;
  toolMode: string;
  allowedTools: string[];
  toolRetry: Record<string, unknown>;
  maxLoops: number;
  timeoutMs?: number;
  mcpServers: Array<{ command: string; args?: string[]; env?: Record<string, string> }>;
  runContract?: RunContractMetadata;
  status: RunSpecStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRunSpecInput {
  id: string;
  sessionId: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  nodeId?: string;
  requestId?: string;
  traceId?: string;
  prompt: string;
  systemPrompt?: string;
  provider?: string;
  model?: string;
  modelSettings?: Record<string, unknown>;
  workspaceRoot: string;
  toolMode: string;
  allowedTools?: string[];
  toolRetry?: Record<string, unknown>;
  maxLoops?: number;
  timeoutMs?: number;
  mcpServers?: Array<{ command: string; args?: string[]; env?: Record<string, string> }>;
  runContract?: RunContractMetadataInput;
}

// ── Schema ──────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS run_specs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tenant_id TEXT,
  project_id TEXT,
  user_id TEXT,
  node_id TEXT,
  request_id TEXT,
  trace_id TEXT,
  prompt TEXT NOT NULL,
  system_prompt TEXT,
  provider TEXT,
  model TEXT,
  model_settings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  workspace_root TEXT NOT NULL,
  tool_mode TEXT NOT NULL,
  allowed_tools_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  tool_retry_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  max_loops INTEGER NOT NULL DEFAULT 20,
  timeout_ms INTEGER,
  mcp_servers_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  run_contract_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'created',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE run_specs ADD COLUMN IF NOT EXISTS run_contract_json JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_run_specs_session_id ON run_specs(session_id);
CREATE INDEX IF NOT EXISTS idx_run_specs_status ON run_specs(status);
CREATE INDEX IF NOT EXISTS idx_run_specs_tenant_project ON run_specs(tenant_id, project_id);
CREATE INDEX IF NOT EXISTS idx_run_specs_request_id ON run_specs(request_id);
CREATE INDEX IF NOT EXISTS idx_run_specs_trace_id ON run_specs(trace_id);
`;

let _initialized = false;

export async function ensureRunSpecStore(): Promise<void> {
  if (_initialized) return;
  const db = getDb();
  await db.exec(SCHEMA);
  _initialized = true;
}

// ── CRUD ────────────────────────────────────────────────

export async function createRunSpec(input: CreateRunSpecInput): Promise<RunSpecRecord> {
  await ensureRunSpecStore();
  const db = getDb();
  const runContract = normalizeRunContractMetadata(input.runContract);
  const rows = await db.query<RunSpecRow>(
    `
    INSERT INTO run_specs (
      id, session_id, tenant_id, project_id, user_id, node_id,
      request_id, trace_id, prompt, system_prompt, provider, model,
      model_settings_json, workspace_root, tool_mode, allowed_tools_json,
      tool_retry_json, max_loops, timeout_ms, mcp_servers_json, run_contract_json, status
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16::jsonb, $17::jsonb, $18, $19, $20::jsonb, $21::jsonb, 'created')
    RETURNING *
  `,
    [
      input.id,
      input.sessionId,
      input.tenantId ?? null,
      input.projectId ?? null,
      input.userId ?? null,
      input.nodeId ?? null,
      input.requestId ?? null,
      input.traceId ?? null,
      input.prompt,
      input.systemPrompt ?? null,
      input.provider ?? null,
      input.model ?? null,
      JSON.stringify(input.modelSettings ?? {}),
      input.workspaceRoot,
      input.toolMode,
      JSON.stringify(input.allowedTools ?? []),
      JSON.stringify(input.toolRetry ?? {}),
      input.maxLoops ?? 20,
      input.timeoutMs ?? null,
      JSON.stringify(input.mcpServers ?? []),
      JSON.stringify(runContract ?? {}),
    ],
  );
  const record = rowToRecord(assertRow(rows.rows[0]));
  await seedVerificationRequirementsForRunSpec({
    runSpecId: record.id,
    sessionId: record.sessionId,
    requiredChecks: runContract?.requiredChecks,
  });
  return record;
}

export async function loadRunSpec(id: string): Promise<RunSpecRecord | null> {
  await ensureRunSpecStore();
  const db = getDb();
  const rows = await db.query<RunSpecRow>('SELECT * FROM run_specs WHERE id = $1', [id]);
  return rows.rows[0] ? rowToRecord(rows.rows[0]) : null;
}

export async function listRunSpecs(limit = 50): Promise<RunSpecRecord[]> {
  await ensureRunSpecStore();
  const db = getDb();
  const rows = await db.query<RunSpecRow>(
    'SELECT * FROM run_specs ORDER BY updated_at DESC LIMIT $1',
    [limit],
  );
  return rows.rows.map(rowToRecord);
}

export async function listRunSpecsForSession(sessionId: string, limit = 20): Promise<RunSpecRecord[]> {
  await ensureRunSpecStore();
  const db = getDb();
  const rows = await db.query<RunSpecRow>(
    'SELECT * FROM run_specs WHERE session_id = $1 ORDER BY updated_at DESC LIMIT $2',
    [sessionId, limit],
  );
  return rows.rows.map(rowToRecord);
}

export async function updateRunSpecStatus(
  id: string,
  status: RunSpecStatus,
): Promise<RunSpecRecord | null> {
  await ensureRunSpecStore();
  const db = getDb();
  const rows = await db.query<RunSpecRow>(
    `
    UPDATE run_specs
    SET status = $2, updated_at = now()
    WHERE id = $1
    RETURNING *
  `,
    [id, status],
  );
  return rows.rows[0] ? rowToRecord(rows.rows[0]) : null;
}

// ── Helpers ─────────────────────────────────────────────

type RunSpecRow = {
  id: string;
  session_id: string;
  tenant_id: string | null;
  project_id: string | null;
  user_id: string | null;
  node_id: string | null;
  request_id: string | null;
  trace_id: string | null;
  prompt: string;
  system_prompt: string | null;
  provider: string | null;
  model: string | null;
  model_settings_json: unknown;
  workspace_root: string;
  tool_mode: string;
  allowed_tools_json: unknown;
  tool_retry_json: unknown;
  max_loops: number;
  timeout_ms: number | null;
  mcp_servers_json: unknown;
  run_contract_json: unknown;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
};

function rowToRecord(row: RunSpecRow): RunSpecRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    tenantId: row.tenant_id ?? undefined,
    projectId: row.project_id ?? undefined,
    userId: row.user_id ?? undefined,
    nodeId: row.node_id ?? undefined,
    requestId: row.request_id ?? undefined,
    traceId: row.trace_id ?? undefined,
    prompt: row.prompt,
    systemPrompt: row.system_prompt ?? undefined,
    provider: row.provider ?? undefined,
    model: row.model ?? undefined,
    modelSettings: normalizeJsonObject(row.model_settings_json),
    workspaceRoot: row.workspace_root,
    toolMode: row.tool_mode,
    allowedTools: normalizeJsonArray(row.allowed_tools_json).map(String),
    toolRetry: normalizeJsonObject(row.tool_retry_json),
    maxLoops: row.max_loops,
    timeoutMs: row.timeout_ms ?? undefined,
    mcpServers: normalizeMCPServers(row.mcp_servers_json),
    runContract: normalizeRunContractMetadata(row.run_contract_json),
    status: row.status as RunSpecStatus,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function normalizeJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { const p = JSON.parse(value); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const p = JSON.parse(value);
      return p && typeof p === 'object' && !Array.isArray(p) ? p as Record<string, unknown> : {};
    } catch { return {}; }
  }
  return {};
}

function normalizeMCPServers(value: unknown): RunSpecRecord['mcpServers'] {
  const raw = normalizeJsonArray(value);
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .map(item => ({
      command: String(item.command ?? ''),
      args: Array.isArray(item.args) ? item.args.map(String) : undefined,
      env: item.env && typeof item.env === 'object' ? item.env as Record<string, string> : undefined,
    }));
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('Failed to create run spec');
  return row;
}
