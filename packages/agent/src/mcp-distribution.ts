import { getDb } from '@los/infra/db';
import {
  loadMCPServer,
  upsertMCPServer,
  type MCPServerRecord,
  type MCPTransport,
  type UpsertMCPServerInput,
} from './mcp-servers.js';
import {
  mcpDistributionVersionHash,
  normalizeMCPAuthConfig,
  normalizeMCPToolPolicy,
  mcpServerExecutionBlocker,
  type MCPAuthConfig,
  type MCPToolPolicy,
} from './mcp-distribution-policy.js';

export interface MCPInspectInput {
  id: string;
  tenantId?: string;
  projectId?: string;
  transport: MCPTransport;
  command?: string;
  args?: string[];
  url?: string;
  sourceUri?: string;
  authConfig?: MCPAuthConfig;
  toolPolicy?: MCPToolPolicy;
}

export interface MCPInspection {
  normalized: UpsertMCPServerInput;
  versionHash: string;
  executionSupported: boolean;
  blockers: string[];
}

export interface MCPServerVersionRecord {
  versionHash: string;
  snapshot: Record<string, unknown>;
  createdAt: string;
}

export function inspectMCPServer(input: MCPInspectInput): MCPInspection {
  const authConfig = normalizeMCPAuthConfig(input.authConfig);
  const toolPolicy = normalizeMCPToolPolicy(input.toolPolicy);
  const normalized: UpsertMCPServerInput = {
    id: input.id.trim(),
    tenantId: input.tenantId?.trim() || undefined,
    projectId: input.projectId?.trim() || undefined,
    transport: input.transport,
    command: input.command?.trim() || undefined,
    args: (input.args ?? []).map(item => item.trim()).filter(Boolean),
    url: input.url?.trim() || undefined,
    sourceUri: input.sourceUri?.trim() || `manual:${input.id.trim()}`,
    authConfig,
    toolPolicy,
    enabled: false,
  };
  if (!normalized.id) throw new Error('id is required');
  if (normalized.transport === 'stdio' && !normalized.command) throw new Error('command is required for stdio transport');
  if (normalized.transport !== 'stdio' && !normalized.url) throw new Error('url is required for remote transport');
  const versionHash = mcpDistributionVersionHash({
    ...normalized,
    envKeys: [],
  });
  const blockers: string[] = [];
  if (normalized.transport !== 'stdio') blockers.push(`transport ${normalized.transport} is not implemented`);
  if (authConfig.mode !== 'none') blockers.push(`auth mode ${authConfig.mode} has no credential resolver`);
  return { normalized: { ...normalized, versionHash }, versionHash, executionSupported: blockers.length === 0, blockers };
}

export async function listMCPServerVersions(id: string, tenantId?: string, projectId?: string): Promise<MCPServerVersionRecord[]> {
  const rows = await getDb().query<{ version_hash: string; snapshot_json: unknown; created_at: Date | string }>(
    `SELECT version_hash, snapshot_json, created_at FROM mcp_server_versions
     WHERE id = $1 AND tenant_id = $2 AND project_id = $3 ORDER BY created_at DESC`,
    [id, tenantId?.trim() ?? '', projectId?.trim() ?? ''],
  );
  return rows.rows.map(row => ({
    versionHash: row.version_hash,
    snapshot: normalizeObject(row.snapshot_json),
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

export async function pinMCPServerVersion(id: string, tenantId?: string, projectId?: string, versionHash?: string): Promise<MCPServerRecord> {
  const server = await requireServer(id, tenantId, projectId);
  const target = versionHash ?? server.versionHash;
  const versions = await listMCPServerVersions(id, tenantId, projectId);
  if (!versions.some(version => version.versionHash === target)) throw new Error('MCP server version not found');
  await getDb().query(
    'UPDATE mcp_servers SET pinned_version_hash = $4, updated_at = now() WHERE id = $1 AND tenant_id = $2 AND project_id = $3',
    [id, tenantId?.trim() ?? '', projectId?.trim() ?? '', target],
  );
  return await requireServer(id, tenantId, projectId);
}

export async function unpinMCPServerVersion(id: string, tenantId?: string, projectId?: string): Promise<MCPServerRecord> {
  await requireServer(id, tenantId, projectId);
  await getDb().query(
    'UPDATE mcp_servers SET pinned_version_hash = NULL, updated_at = now() WHERE id = $1 AND tenant_id = $2 AND project_id = $3',
    [id, tenantId?.trim() ?? '', projectId?.trim() ?? ''],
  );
  return await requireServer(id, tenantId, projectId);
}

export async function setMCPServerEnabled(id: string, enabled: boolean, tenantId?: string, projectId?: string): Promise<MCPServerRecord> {
  const server = await requireServer(id, tenantId, projectId);
  if (enabled) {
    const blocker = mcpServerExecutionBlocker({ ...server, enabled: true });
    if (blocker) throw new Error(blocker);
  }
  await getDb().query(
    'UPDATE mcp_servers SET enabled = $4, updated_at = now() WHERE id = $1 AND tenant_id = $2 AND project_id = $3',
    [id, tenantId?.trim() ?? '', projectId?.trim() ?? '', enabled],
  );
  return await requireServer(id, tenantId, projectId);
}

export async function rollbackMCPServerVersion(id: string, versionHash: string, tenantId?: string, projectId?: string): Promise<MCPServerRecord> {
  const current = await requireServer(id, tenantId, projectId);
  if (current.pinnedVersionHash && current.pinnedVersionHash !== versionHash) {
    throw new Error(`MCP server is pinned to version ${current.pinnedVersionHash}`);
  }
  const version = (await listMCPServerVersions(id, tenantId, projectId)).find(item => item.versionHash === versionHash);
  if (!version) throw new Error('MCP server version not found');
  const snapshot = version.snapshot;
  return await upsertMCPServer({
    id,
    tenantId,
    projectId,
    transport: snapshot.transport as MCPTransport,
    command: optionalString(snapshot.command),
    args: stringArray(snapshot.args),
    url: optionalString(snapshot.url),
    env: current.env,
    sourceUri: optionalString(snapshot.sourceUri),
    authConfig: normalizeMCPAuthConfig(snapshot.authConfig),
    toolPolicy: normalizeMCPToolPolicy(snapshot.toolPolicy),
    versionHash,
    pinnedVersionHash: current.pinnedVersionHash ?? null,
    allowPinnedUpdate: true,
    enabled: false,
  });
}

async function requireServer(id: string, tenantId?: string, projectId?: string): Promise<MCPServerRecord> {
  const server = await loadMCPServer(id, tenantId, projectId);
  if (!server) throw new Error('MCP server not found');
  return server;
}

function normalizeObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new Error('Invalid MCP version snapshot');
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}
