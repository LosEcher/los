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
  env: Record<string, string>;
  enabled: boolean;
  status: MCPServerStatus;
  lastError?: string;
  toolCount: number;
  tools: MCPRegisteredTool[];
  createdAt: string;
  updatedAt: string;
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
