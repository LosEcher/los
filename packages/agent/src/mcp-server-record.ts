import { normalizeMCPAuthConfig, normalizeMCPToolPolicy, type MCPAuthConfig, type MCPToolPolicy } from './mcp-distribution-policy.js';
import {
  normalizeMCPAdapterConfig,
  type CanToolCapabilityProjection,
  type MCPAdapterConfig,
} from './cantool-capability-adapter.js';

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
  adapterConfig: MCPAdapterConfig;
  adapterEvidence?: MCPAdapterEvidence;
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
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  capability?: CanToolCapabilityProjection;
}

export interface MCPAdapterEvidence {
  serverName?: string;
  serverVersion?: string;
  protocolVersion?: string;
  verifiedAt: string;
  capabilitySummary?: {
    projected: number;
    available: number;
    blocked: number;
    byDataClassification: Record<string, number>;
  };
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
  adapterConfig?: MCPAdapterConfig;
  allowPinnedUpdate?: boolean;
  enabled?: boolean;
}

export interface UpdateMCPServerStatusInput {
  status?: MCPServerStatus;
  lastError?: string | null;
  toolCount?: number;
  tools?: MCPRegisteredTool[];
  adapterEvidence?: MCPAdapterEvidence;
}

export interface ListMCPServersOptions {
  tenantId?: string;
  projectId?: string;
  enabled?: boolean;
}

export type MCPServerRow = {
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

export function _rowToMCPServerRecord(row: MCPServerRow): MCPServerRecord {
  const distribution = normalizeObject(row.distribution_json);
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
    adapterConfig: normalizeMCPAdapterConfig(distribution.adapterConfig),
    adapterEvidence: normalizeAdapterEvidence(distribution.adapterEvidence),
    enabled: row.enabled,
    status: row.status as MCPServerStatus,
    lastError: row.last_error ?? undefined,
    toolCount: row.tool_count,
    tools: normalizeToolArray(row.tools_json),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

export function _normalizeMCPScopeValue(value: string | undefined): string {
  return value?.trim() ?? '';
}

export function _assertMCPServerRow<T>(row: T | undefined): T {
  if (!row) throw new Error('Failed to upsert MCP server');
  return row;
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

function normalizeObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch { return {}; }
  }
  return {};
}

function normalizeAdapterEvidence(value: unknown): MCPAdapterEvidence | undefined {
  const raw = normalizeObject(value);
  if (typeof raw.verifiedAt !== 'string') return undefined;
  return raw as unknown as MCPAdapterEvidence;
}

function normalizeEnvObject(value: unknown): Record<string, string> {
  const raw = normalizeObject(value);
  const env: Record<string, string> = {};
  for (const [key, item] of Object.entries(raw)) {
    if (typeof item === 'string') env[key] = item;
  }
  return env;
}

function normalizeToolArray(value: unknown): MCPRegisteredTool[] {
  return normalizeJsonArray(value)
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    .map(item => ({
      name: String(item.name ?? ''),
      title: typeof item.title === 'string' ? item.title : undefined,
      description: typeof item.description === 'string' ? item.description : undefined,
      inputSchema: normalizeObject(item.inputSchema),
      outputSchema: item.outputSchema ? normalizeObject(item.outputSchema) : undefined,
      annotations: item.annotations ? normalizeObject(item.annotations) : undefined,
      capability: item.capability && typeof item.capability === 'object'
        ? (item.capability as unknown as CanToolCapabilityProjection)
        : undefined,
    }))
    .filter(tool => tool.name);
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
