import { contentVersionHash } from './distribution-version.js';

export type MCPAuthMode = 'none' | 'credential_ref' | 'oauth';
export type MCPToolRiskLevel = 'L0' | 'L1' | 'L2';

export interface MCPAuthConfig {
  mode: MCPAuthMode;
  credentialRef?: string;
}

export interface MCPToolPolicy {
  allow: string[];
  deny: string[];
  riskLevel: MCPToolRiskLevel;
}

export interface MCPDistributionConfig {
  id: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  command?: string;
  args?: string[];
  url?: string;
  envKeys?: string[];
  sourceUri?: string;
  authConfig?: MCPAuthConfig;
  toolPolicy?: MCPToolPolicy;
}

export function normalizeMCPAuthConfig(value: unknown): MCPAuthConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { mode: 'none' };
  const raw = value as Record<string, unknown>;
  const mode = raw.mode === 'credential_ref' || raw.mode === 'oauth' ? raw.mode : 'none';
  if (mode === 'none') return { mode };
  const credentialRef = typeof raw.credentialRef === 'string' ? raw.credentialRef.trim() : '';
  if (!credentialRef) throw new Error(`credentialRef is required for MCP auth mode ${mode}`);
  if (/\s/.test(credentialRef) || credentialRef.length > 256) throw new Error('credentialRef must be an opaque identifier');
  return { mode, credentialRef };
}

export function normalizeMCPToolPolicy(value: unknown): MCPToolPolicy {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    allow: normalizeNames(raw.allow),
    deny: normalizeNames(raw.deny),
    riskLevel: raw.riskLevel === 'L0' || raw.riskLevel === 'L2' ? raw.riskLevel : 'L1',
  };
}

export function mcpDistributionVersionHash(config: MCPDistributionConfig): string {
  return contentVersionHash({
    id: config.id,
    transport: config.transport,
    command: config.command ?? '',
    args: config.args ?? [],
    url: config.url ?? '',
    envKeys: [...(config.envKeys ?? [])].sort(),
    sourceUri: config.sourceUri ?? '',
    authConfig: normalizeMCPAuthConfig(config.authConfig),
    toolPolicy: normalizeMCPToolPolicy(config.toolPolicy),
  });
}

export function isMCPToolAllowed(policy: MCPToolPolicy, toolName: string): boolean {
  if (policy.deny.includes(toolName)) return false;
  return policy.allow.length === 0 || policy.allow.includes(toolName);
}

export function mcpServerExecutionBlocker(server: {
  enabled: boolean;
  status: string;
  pinnedVersionHash?: string;
  versionHash: string;
  transport: string;
  authConfig: MCPAuthConfig;
  command?: string;
}): string | undefined {
  if (!server.enabled) return 'server is disabled';
  if (server.status !== 'connected') return `server status is ${server.status}`;
  if (server.pinnedVersionHash && server.pinnedVersionHash !== server.versionHash) return 'pinned version does not match current version';
  if (server.transport !== 'stdio') return `transport ${server.transport} is not implemented`;
  if (server.authConfig.mode !== 'none') return `auth mode ${server.authConfig.mode} has no credential resolver`;
  if (!server.command) return 'stdio command is missing';
  return undefined;
}

export function mcpVersionSnapshot(record: MCPDistributionConfig & {
  tenantId?: string;
  projectId?: string;
  versionHash: string;
}): Record<string, unknown> {
  return {
    id: record.id, tenantId: record.tenantId, projectId: record.projectId,
    transport: record.transport, command: record.command, args: record.args,
    url: record.url, envKeys: record.envKeys ?? [], sourceUri: record.sourceUri,
    versionHash: record.versionHash, authConfig: record.authConfig,
    toolPolicy: record.toolPolicy,
  };
}

function normalizeNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map(item => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean))].sort();
}
