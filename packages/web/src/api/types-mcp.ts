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
  adapterConfig: MCPAdapterConfig;
  adapterEvidence?: MCPAdapterEvidence;
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

export type MCPAdapterConfig =
  | { kind: 'generic' }
  | {
      kind: 'cantool';
      providerId: 'cantool.mcp.local';
      providerLocation: 'local';
      dataGrantOwner: 'cantool';
      sessionBinding: 'per_call';
    };

export type MCPCapabilityProjection = {
  capabilityId: string;
  dataClassification: 'public' | 'caller_supplied' | 'local_metadata' | 'local_private' | 'secret' | 'unknown';
  providerId: string;
  providerLocation: 'local';
  availability: 'available' | 'blocked';
  reason: string;
  approvalMode: 'none' | 'cantool_data_grant' | 'not_available';
  grantRequired: boolean;
  sessionBinding: 'per_call';
  cancellation: 'mcp_notification_late_result_discarded';
  resume: 'new_call_only';
  readOnly: boolean;
  idempotent: boolean;
};

export type MCPAdapterEvidence = {
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
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  capability?: MCPCapabilityProjection;
};

export type MCPServerListResponse = {
  count: number;
  servers: MCPServer[];
};

export type MCPServerVerifyResponse = {
  ok: boolean;
  serverId: string;
  toolCount?: number;
  adapterEvidence?: Omit<MCPAdapterEvidence, 'verifiedAt'>;
  tools?: Array<{ name: string; description?: string; capability?: MCPCapabilityProjection }>;
  error?: string;
};
