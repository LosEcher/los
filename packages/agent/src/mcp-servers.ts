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
} from './mcp-distribution-policy.js';
import { _MCP_SERVER_SCHEMA } from './mcp-server-schema.js';
import {
  normalizeCanToolPolicy,
  normalizeMCPAdapterConfig,
} from './cantool-capability-adapter.js';
import {
  _assertMCPServerRow,
  _normalizeMCPScopeValue,
  _rowToMCPServerRecord,
  type ListMCPServersOptions,
  type MCPServerRecord,
  type MCPServerRow,
  type MCPTransport,
  type UpdateMCPServerStatusInput,
  type UpsertMCPServerInput,
} from './mcp-server-record.js';

export type {
  ListMCPServersOptions,
  MCPAdapterEvidence,
  MCPRegisteredTool,
  MCPServerRecord,
  MCPServerStatus,
  MCPTransport,
  UpdateMCPServerStatusInput,
  UpsertMCPServerInput,
} from './mcp-server-record.js';

// ── Types ───────────────────────────────────────────────

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
  const tenantId = _normalizeMCPScopeValue(input.tenantId);
  const projectId = _normalizeMCPScopeValue(input.projectId);
  const existing = await loadMCPServer(input.id, tenantId, projectId);
  const authConfig = normalizeMCPAuthConfig(input.authConfig);
  const adapterConfig = normalizeMCPAdapterConfig(input.adapterConfig);
  const requestedToolPolicy = normalizeMCPToolPolicy(input.toolPolicy);
  const toolPolicy = adapterConfig.kind === 'cantool'
    ? normalizeCanToolPolicy(requestedToolPolicy)
    : requestedToolPolicy;
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
    adapterConfig,
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
      JSON.stringify({ inspected: true, envKeys: Object.keys(env).sort(), adapterConfig }),
    ],
  );
  const record = _rowToMCPServerRecord(_assertMCPServerRow(rows.rows[0]));
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
    [id, _normalizeMCPScopeValue(tenantId), _normalizeMCPScopeValue(projectId)],
  );
  return rows.rows[0] ? _rowToMCPServerRecord(rows.rows[0]) : null;
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
  return rows.rows.map(_rowToMCPServerRecord);
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
    [id, _normalizeMCPScopeValue(tenantId), _normalizeMCPScopeValue(projectId)],
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
        distribution_json = CASE WHEN $8::jsonb IS NOT NULL
          THEN distribution_json || jsonb_build_object('adapterEvidence', $8::jsonb)
          ELSE distribution_json END,
        updated_at = now()
    WHERE id = $1
      AND tenant_id = $2
      AND project_id = $3
    RETURNING *
  `,
    [
      id,
      _normalizeMCPScopeValue(tenantId),
      _normalizeMCPScopeValue(projectId),
      input.status ?? null,
      input.lastError ?? null,
      input.toolCount ?? null,
      input.tools ? JSON.stringify(input.tools) : null,
      input.adapterEvidence ? JSON.stringify(input.adapterEvidence) : null,
    ],
  );
  return rows.rows[0] ? _rowToMCPServerRecord(rows.rows[0]) : null;
}
