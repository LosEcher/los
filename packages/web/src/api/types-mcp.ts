export type ToolRetry = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

export type MCPServerPayload = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type MCPTransport = 'stdio' | 'sse' | 'streamable-http';
export type MCPServerStatus = 'unverified' | 'connected' | 'error' | 'disabled';

export type MCPServer = {
  id: string;
  tenantId?: string;
  projectId?: string;
  transport: MCPTransport;
  command?: string;
  args: string[];
  url?: string;
  envKeys: string[];
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
};

export type MCPAuthConfig = {
  mode: 'none' | 'credential_ref' | 'oauth';
  credentialRef?: string;
};

export type MCPToolPolicy = {
  allow: string[];
  deny: string[];
  riskLevel: 'L0' | 'L1' | 'L2';
};

export type MCPInspection = {
  normalized: Record<string, unknown>;
  versionHash: string;
  executionSupported: boolean;
  blockers: string[];
};

export type MCPHistoryResponse = {
  currentVersionHash: string;
  pinnedVersionHash?: string;
  versions: Array<{ versionHash: string; snapshot: Record<string, unknown>; createdAt: string }>;
};

export type MCPRegisteredTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export type MCPServerListResponse = {
  count: number;
  servers: MCPServer[];
};

export type MCPServerVerifyResponse = {
  ok: boolean;
  serverId: string;
  toolCount?: number;
  tools?: Array<{ name: string; description?: string }>;
  error?: string;
};
