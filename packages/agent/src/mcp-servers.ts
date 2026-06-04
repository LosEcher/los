/**
 * @los/agent/mcp-servers — Persistent MCP server registry.
 *
 * Stores MCP server configurations in PostgreSQL so they survive
 * across sessions and don't need to be re-sent with every /chat request.
 */

import { getDb } from '@los/infra/db';

// ── Types ───────────────────────────────────────────────

export type MCPTransport = 'stdio' | 'sse' | 'streamable-http';
export type MCPServerStatus = 'unverified' | 'connected' | 'error' | 'disabled';

export interface MCPServerRecord {
  id: string;
  tenantId?: string;
  projectId?: string;
  transport: MCPTransport;
  command?: string;
  args: string[];
  url?: string;
  env: Record<string, string>;
  enabled: boolean;
  status: MCPServerStatus;
  lastError?: string;
  toolCount: number;
  tools: MCPRegisteredTool[];
  createdAt: string;
  updatedAt: string;
}

export interface MCPRegisteredTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface UpsertMCPServerInput {
  id: string;
  tenantId?: string;
  projectId?: string;
  transport: MCPTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  enabled?: boolean;
}

export interface UpdateMCPServerStatusInput {
  status?: MCPServerStatus;
  lastError?: string | null;
  toolCount?: number;
  tools?: MCPRegisteredTool[];
}

export interface ListMCPServersOptions {
  tenantId?: string;
  projectId?: string;
  enabled?: boolean;
}

// ── Schema ──────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT NOT NULL,
  tenant_id TEXT,
  project_id TEXT,
  transport TEXT NOT NULL DEFAULT 'stdio',
  command TEXT,
  args_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  url TEXT,
  env_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'unverified',
  last_error TEXT,
  tool_count INTEGER NOT NULL DEFAULT 0,
  tools_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, COALESCE(tenant_id, ''), COALESCE(project_id, ''))
);

CREATE INDEX IF NOT EXISTS idx_mcp_servers_tenant_project
  ON mcp_servers(tenant_id, project_id);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled
  ON mcp_servers(enabled) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_mcp_servers_status
  ON mcp_servers(status);
`;

let _initialized = false;

export async function ensureMCPServerStore(): Promise<void> {
  if (_initialized) return;
  const db = getDb();
  await db.exec(SCHEMA);
  _initialized = true;
}

// ── CRUD ────────────────────────────────────────────────

export async function upsertMCPServer(input: UpsertMCPServerInput): Promise<MCPServerRecord> {
  await ensureMCPServerStore();
  const db = getDb();
  const rows = await db.query<MCPServerRow>(
    `
    INSERT INTO mcp_servers (
      id, tenant_id, project_id, transport, command, args_json, url,
      env_json, enabled, status, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9, 'unverified', now())
    ON CONFLICT (id, COALESCE(tenant_id, ''), COALESCE(project_id, ''))
    DO UPDATE SET
      transport = EXCLUDED.transport,
      command = EXCLUDED.command,
      args_json = EXCLUDED.args_json,
      url = EXCLUDED.url,
      env_json = EXCLUDED.env_json,
      enabled = EXCLUDED.enabled,
      updated_at = now()
    RETURNING *
  `,
    [
      input.id,
      input.tenantId ?? null,
      input.projectId ?? null,
      input.transport,
      input.command ?? null,
      JSON.stringify(input.args ?? []),
      input.url ?? null,
      JSON.stringify(input.env ?? {}),
      input.enabled ?? true,
    ],
  );
  return rowToRecord(assertRow(rows.rows[0]));
}

export async function loadMCPServer(
  id: string,
  tenantId?: string,
  projectId?: string,
): Promise<MCPServerRecord | null> {
  await ensureMCPServerStore();
  const db = getDb();
  const rows = await db.query<MCPServerRow>(
    `
    SELECT * FROM mcp_servers
    WHERE id = $1
      AND (tenant_id = $2 OR (tenant_id IS NULL AND $2 IS NULL))
      AND (project_id = $3 OR (project_id IS NULL AND $3 IS NULL))
    `,
    [id, tenantId ?? null, projectId ?? null],
  );
  return rows.rows[0] ? rowToRecord(rows.rows[0]) : null;
}

export async function listMCPServers(
  options: ListMCPServersOptions = {},
): Promise<MCPServerRecord[]> {
  await ensureMCPServerStore();
  const db = getDb();

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (options.tenantId !== undefined) {
    conditions.push(`tenant_id = $${idx++}`);
    params.push(options.tenantId);
  }
  if (options.projectId !== undefined) {
    conditions.push(`project_id = $${idx++}`);
    params.push(options.projectId);
  }
  if (options.enabled !== undefined) {
    conditions.push(`enabled = $${idx++}`);
    params.push(options.enabled);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await db.query<MCPServerRow>(
    `SELECT * FROM mcp_servers ${where} ORDER BY id ASC`,
    params,
  );
  return rows.rows.map(rowToRecord);
}

export async function deleteMCPServer(
  id: string,
  tenantId?: string,
  projectId?: string,
): Promise<boolean> {
  await ensureMCPServerStore();
  const db = getDb();
  const rows = await db.query<{ id: string }>(
    `
    DELETE FROM mcp_servers
    WHERE id = $1
      AND (tenant_id = $2 OR (tenant_id IS NULL AND $2 IS NULL))
      AND (project_id = $3 OR (project_id IS NULL AND $3 IS NULL))
    RETURNING id
  `,
    [id, tenantId ?? null, projectId ?? null],
  );
  return rows.rows.length > 0;
}

export async function updateMCPServerStatus(
  id: string,
  input: UpdateMCPServerStatusInput,
  tenantId?: string,
  projectId?: string,
): Promise<MCPServerRecord | null> {
  await ensureMCPServerStore();
  const db = getDb();
  const rows = await db.query<MCPServerRow>(
    `
    UPDATE mcp_servers
    SET status = COALESCE($4, status),
        last_error = $5,
        tool_count = COALESCE($6, tool_count),
        tools_json = CASE WHEN $7::jsonb IS NOT NULL THEN $7::jsonb ELSE tools_json END,
        updated_at = now()
    WHERE id = $1
      AND (tenant_id = $2 OR (tenant_id IS NULL AND $2 IS NULL))
      AND (project_id = $3 OR (project_id IS NULL AND $3 IS NULL))
    RETURNING *
  `,
    [
      id,
      tenantId ?? null,
      projectId ?? null,
      input.status ?? null,
      input.lastError ?? null,
      input.toolCount ?? null,
      input.tools ? JSON.stringify(input.tools) : null,
    ],
  );
  return rows.rows[0] ? rowToRecord(rows.rows[0]) : null;
}

// ── Helpers ─────────────────────────────────────────────

type MCPServerRow = {
  id: string;
  tenant_id: string | null;
  project_id: string | null;
  transport: string;
  command: string | null;
  args_json: unknown;
  url: string | null;
  env_json: unknown;
  enabled: boolean;
  status: string;
  last_error: string | null;
  tool_count: number;
  tools_json: unknown;
  created_at: Date | string;
  updated_at: Date | string;
};

function rowToRecord(row: MCPServerRow): MCPServerRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id ?? undefined,
    projectId: row.project_id ?? undefined,
    transport: row.transport as MCPTransport,
    command: row.command ?? undefined,
    args: normalizeJsonArray(row.args_json).map(String),
    url: row.url ?? undefined,
    env: normalizeEnvObject(row.env_json),
    enabled: row.enabled,
    status: row.status as MCPServerStatus,
    lastError: row.last_error ?? undefined,
    toolCount: row.tool_count,
    tools: normalizeToolArray(row.tools_json),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function normalizeJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
}

function normalizeEnvObject(value: unknown): Record<string, string> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string') env[k] = v;
    }
    return env;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === 'string') env[k] = v;
        }
        return env;
      }
    } catch { return {}; }
  }
  return {};
}

function normalizeToolArray(value: unknown): MCPRegisteredTool[] {
  const raw = normalizeJsonArray(value);
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    .map(item => ({
      name: String(item.name ?? ''),
      description: typeof item.description === 'string' ? item.description : undefined,
      inputSchema: item.inputSchema && typeof item.inputSchema === 'object'
        ? (item.inputSchema as Record<string, unknown>)
        : { type: 'object' },
    }))
    .filter(t => t.name);
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('Failed to upsert MCP server');
  return row;
}
