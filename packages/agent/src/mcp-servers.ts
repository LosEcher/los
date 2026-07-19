/**
 * @los/agent/mcp-servers — Persistent MCP server registry.
 *
 * Stores MCP server configurations in PostgreSQL so they survive
 * across sessions and don't need to be re-sent with every /chat request.
 */

import { getDb } from '@los/infra/db';
import {
  mcpDistributionVersionHash,
  mcpVersionSnapshot,
  normalizeMCPAuthConfig,
  normalizeMCPToolPolicy,
  type MCPAuthConfig,
  type MCPToolPolicy,
} from './mcp-distribution-policy.js';
import { _MCP_SERVER_SCHEMA } from './mcp-server-schema.js';

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
  sourceUri: string;
  versionHash: string;
  pinnedVersionHash?: string;
  authConfig: MCPAuthConfig;
  toolPolicy: MCPToolPolicy;
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
  sourceUri?: string;
  versionHash?: string;
  pinnedVersionHash?: string | null;
  authConfig?: MCPAuthConfig;
  toolPolicy?: MCPToolPolicy;
  allowPinnedUpdate?: boolean;
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

let _initialized = false;

export async function ensureMCPServerStore(): Promise<void> {
  if (_initialized) return;
  const db = getDb();
  await db.exec(_MCP_SERVER_SCHEMA);
  _initialized = true;
}

// ── CRUD ────────────────────────────────────────────────

export async function upsertMCPServer(input: UpsertMCPServerInput): Promise<MCPServerRecord> {
  await ensureMCPServerStore();
  const db = getDb();
  const tenantId = normalizeScopeValue(input.tenantId);
  const projectId = normalizeScopeValue(input.projectId);
  const existing = await loadMCPServer(input.id, tenantId, projectId);
  const authConfig = normalizeMCPAuthConfig(input.authConfig);
  const toolPolicy = normalizeMCPToolPolicy(input.toolPolicy);
  const env = input.env ?? {};
  const versionHash = mcpDistributionVersionHash({
    id: input.id,
    transport: input.transport,
    command: input.command,
    args: input.args,
    url: input.url,
    envKeys: Object.keys(env),
    sourceUri: input.sourceUri,
    authConfig,
    toolPolicy,
  });
  if (input.versionHash && input.versionHash !== versionHash) throw new Error('MCP versionHash must match inspected configuration');
  if (existing?.pinnedVersionHash && existing.pinnedVersionHash !== versionHash && input.allowPinnedUpdate !== true) {
    throw new Error(`MCP server is pinned to version ${existing.pinnedVersionHash}`);
  }
  const rows = await db.query<MCPServerRow>(
    `
    INSERT INTO mcp_servers (
      id, tenant_id, project_id, transport, command, args_json, url,
      env_json, enabled, status, source_uri, version_hash, pinned_version_hash,
      auth_json, tool_policy_json, distribution_json, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9, 'unverified',
      $10, $11, $12, $13::jsonb, $14::jsonb, $15::jsonb, now())
    ON CONFLICT (id, tenant_id, project_id)
    DO UPDATE SET
      transport = EXCLUDED.transport,
      command = EXCLUDED.command,
      args_json = EXCLUDED.args_json,
      url = EXCLUDED.url,
      env_json = EXCLUDED.env_json,
      enabled = EXCLUDED.enabled,
      status = 'unverified',
      last_error = NULL,
      source_uri = EXCLUDED.source_uri,
      version_hash = EXCLUDED.version_hash,
      pinned_version_hash = CASE WHEN $12::text IS NULL THEN mcp_servers.pinned_version_hash ELSE EXCLUDED.pinned_version_hash END,
      auth_json = EXCLUDED.auth_json,
      tool_policy_json = EXCLUDED.tool_policy_json,
      distribution_json = EXCLUDED.distribution_json,
      updated_at = now()
    RETURNING *
  `,
    [
      input.id,
      tenantId,
      projectId,
      input.transport,
      input.command ?? null,
      JSON.stringify(input.args ?? []),
      input.url ?? null,
      JSON.stringify(env),
      input.enabled ?? false,
      input.sourceUri ?? '',
      versionHash,
      input.pinnedVersionHash ?? null,
      JSON.stringify(authConfig),
      JSON.stringify(toolPolicy),
      JSON.stringify({ inspected: true, envKeys: Object.keys(env).sort() }),
    ],
  );
  const record = rowToRecord(assertRow(rows.rows[0]));
  await db.query(
    `INSERT INTO mcp_server_versions (id, tenant_id, project_id, version_hash, snapshot_json)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (id, tenant_id, project_id, version_hash) DO NOTHING`,
    [record.id, tenantId, projectId, record.versionHash, JSON.stringify(mcpVersionSnapshot({ ...record, envKeys: Object.keys(record.env).sort() }))],
  );
  return record;
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
      AND tenant_id = $2
      AND project_id = $3
    `,
    [id, normalizeScopeValue(tenantId), normalizeScopeValue(projectId)],
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
      AND tenant_id = $2
      AND project_id = $3
    RETURNING id
  `,
    [id, normalizeScopeValue(tenantId), normalizeScopeValue(projectId)],
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
      AND tenant_id = $2
      AND project_id = $3
    RETURNING *
  `,
    [
      id,
      normalizeScopeValue(tenantId),
      normalizeScopeValue(projectId),
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
  source_uri: string;
  version_hash: string;
  pinned_version_hash: string | null;
  auth_json: unknown;
  tool_policy_json: unknown;
  distribution_json: unknown;
  created_at: Date | string;
  updated_at: Date | string;
};

function rowToRecord(row: MCPServerRow): MCPServerRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id || undefined,
    projectId: row.project_id || undefined,
    transport: row.transport as MCPTransport,
    command: row.command ?? undefined,
    args: normalizeJsonArray(row.args_json).map(String),
    url: row.url ?? undefined,
    env: normalizeEnvObject(row.env_json),
    sourceUri: row.source_uri,
    versionHash: row.version_hash,
    pinnedVersionHash: row.pinned_version_hash ?? undefined,
    authConfig: normalizeMCPAuthConfig(row.auth_json),
    toolPolicy: normalizeMCPToolPolicy(row.tool_policy_json),
    enabled: row.enabled,
    status: row.status as MCPServerStatus,
    lastError: row.last_error ?? undefined,
    toolCount: row.tool_count,
    tools: normalizeToolArray(row.tools_json),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function normalizeScopeValue(value: string | undefined): string {
  return value?.trim() ?? '';
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
