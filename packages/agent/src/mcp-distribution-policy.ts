import { isApprovedSecretRef } from '@los/infra/provider-accounts';
import { contentVersionHash } from './distribution-version.js';
import type { MCPAdapterConfig } from './cantool-capability-adapter.js';

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
  adapterConfig?: MCPAdapterConfig;
}

export function normalizeMCPAuthConfig(value: unknown): MCPAuthConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { mode: 'none' };
  const raw = value as Record<string, unknown>;
  const mode = raw.mode === 'credential_ref' || raw.mode === 'oauth' ? raw.mode : 'none';
  if (mode === 'none') return { mode };
  const credentialRef = typeof raw.credentialRef === 'string' ? raw.credentialRef.trim() : '';
  if (!credentialRef) throw new Error(`credentialRef is required for MCP auth mode ${mode}`);
  if (/\s/.test(credentialRef) || credentialRef.length > 256) throw new Error('credentialRef must be an opaque identifier');
  // credential_ref must use the same approved secret-ref shape as provider_accounts.
  // oauth remains opaque-only until OAuth transport is implemented (fail-closed at runtime).
  if (mode === 'credential_ref' && !isApprovedSecretRef(credentialRef)) {
    throw new Error('credentialRef must be an approved opaque backend reference');
  }
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
  const adapterConfig = config.adapterConfig ?? { kind: 'generic' as const };
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
    ...(adapterConfig.kind === 'cantool' ? { adapterConfig } : {}),
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
  url?: string;
}): string | undefined {
  if (!server.enabled) return 'server is disabled';
  if (server.status !== 'connected') return `server status is ${server.status}`;
  if (server.pinnedVersionHash && server.pinnedVersionHash !== server.versionHash) return 'pinned version does not match current version';
  if (server.authConfig.mode === 'oauth') return 'unsupported auth mode oauth';
  if (server.authConfig.mode === 'credential_ref') {
    const shapeError = mcpCredentialRefShapeError(server.authConfig.credentialRef);
    if (shapeError) return shapeError;
  } else if (server.authConfig.mode !== 'none') {
    return `unsupported auth mode ${server.authConfig.mode}`;
  }
  if (server.transport === 'stdio' && !server.command) return 'stdio command is missing';
  if (server.transport !== 'stdio' && !server.url) return 'remote transport url is missing';
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
    ...(record.adapterConfig?.kind === 'cantool' ? { adapterConfig: record.adapterConfig } : {}),
  };
}

/** Shape gate for credential_ref — approved secret ref + v1 backends only. */
export function mcpCredentialRefShapeError(ref: string | undefined): string | undefined {
  if (!ref || !ref.trim()) return 'credential_ref not resolved';
  const trimmed = ref.trim();
  if (!isApprovedSecretRef(trimmed)) return 'credential_ref not resolved';
  if (trimmed.startsWith('env:') || trimmed.startsWith('local-file:los-auth/')) return undefined;
  if (trimmed.startsWith('external:') || trimmed.startsWith('adapter:')) return 'backend_not_implemented';
  if (trimmed.startsWith('local-file:')) return 'local_file_prefix_not_allowed';
  return 'credential_ref not resolved';
}

function normalizeNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map(item => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean))].sort();
}
