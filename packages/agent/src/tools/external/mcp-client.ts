/**
 * @los/agent/tools/mcp-client — MCP (Model Context Protocol) client.
 *
 * Connects to MCP servers via stdio, SSE, or streamable-HTTP transport,
 * discovers their tools, and routes tool calls through JSON-RPC.
 *
 * Supports any MCP-compatible server: filesystem, github, puppeteer,
 * memory, databases, Composio, etc.
 */

import { getLogger } from '@los/infra/logger';
import type { MCPToolPolicy } from '../../mcp-distribution-policy.js';
import type {
  MCPAdapterConfig,
  MCPDiscoveredTool,
} from '../../cantool-capability-adapter.js';
import { MCPStdioClient } from '@los/mcp-stdio';
import { MCPSSETransport } from './mcp-sse-transport.js';
import { MCPStreamableHTTPTransport } from './mcp-streamable-http-transport.js';
import type { MCPTransport } from './mcp-transport.js';

const log = getLogger('agent');

// ── Public Types ─────────────────────────────────────────

export interface MCPServerConfig {
  /** stdio command (local servers). Required for stdio transport. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Remote endpoint URL (sse / streamable-http transports). */
  url?: string;
  /** Transport type. Defaults to 'stdio' when command is set. */
  transport?: 'stdio' | 'sse' | 'streamable-http';
  /** Additional HTTP headers for remote transports (auth, etc.). */
  headers?: Record<string, string>;
  serverId?: string;
  toolPolicy?: MCPToolPolicy;
  adapterConfig?: MCPAdapterConfig;
}

export interface MCPToolDef extends MCPDiscoveredTool {
  /**
   * Mirrors the leaf's descriptor index signature. Without it the agent's
   * descriptor is not assignable to the leaf's, and `getTools()` — which every
   * consumer reads — could not be narrowed in this subclass.
   */
  [key: string]: unknown;
}

export interface MCPServerIdentity {
  name?: string;
  version?: string;
  protocolVersion?: string;
}

export interface MCPCallOptions {
  signal?: AbortSignal;
}

interface MCPToolCallResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

// ── Constants ───────────────────────────────────────────

const MCP_PROTOCOL_VERSION = '2024-11-05';
const REQUEST_TIMEOUT_MS = 60_000;

// ── Remote transports (agent-only) ──────────────────────

function createRemoteTransport(config: MCPServerConfig): MCPTransport {
  if (config.transport === 'sse') {
    if (!config.url) throw new Error('MCP SSE transport requires a url');
    return new MCPSSETransport(config.url, config.headers);
  }
  if (config.transport === 'streamable-http') {
    if (!config.url) throw new Error('MCP streamable-http transport requires a url');
    return new MCPStreamableHTTPTransport(config.url, config.headers);
  }
  throw new Error(`Unknown MCP transport: ${config.transport}`);
}

// ── MCP Client ──────────────────────────────────────────

/**
 * Agent-side MCP client.
 *
 * The **stdio** half — spawn, JSON-RPC framing, initialize handshake, request
 * timeout and cancellation — lives in the leaf package `@los/mcp-stdio`, because
 * `@los/memory` needs it and must not depend on `@los/agent`. This class keeps
 * only what is agent-specific:
 *
 *   - the remote transports (SSE / streamable-HTTP), which no non-agent consumer uses;
 *   - `toolPolicy` / `adapterConfig`, which are agent distribution concepts;
 *   - a `toolPolicy`-aware `callTool` override.
 *
 * `MCPServerConfig` here is a superset of the leaf config: extra fields are simply
 * ignored by the leaf.
 */
export class MCPClient extends MCPStdioClient {
  private remoteTransport: MCPTransport | null = null;

  constructor(private readonly agentConfig: MCPServerConfig) {
    // The leaf requires a stdio command. A remote config has no command, so hand it
    // a placeholder and swap in the real transport immediately after.
    super({
      command: agentConfig.command ?? 'unused-remote-transport',
      args: agentConfig.args,
      env: agentConfig.env,
      serverId: agentConfig.serverId,
    });
    if (agentConfig.transport && agentConfig.transport !== 'stdio') {
      this.remoteTransport = createRemoteTransport(agentConfig);
      this.remoteTransport.onMessage((msg) => this.handleMessage(msg));
    }
  }

  /** Remote transports replace the leaf's stdio one entirely. */
  async connect(): Promise<void> {
    if (!this.remoteTransport) {
      return super.connect();
    }
    await this.remoteTransport.start();
    const initResult = await this.sendRequest('initialize', {
      // Same version the leaf advertises; kept literal here so the agent's remote
      // path does not need a second import name for one constant.
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'los', version: '0.1.0' },
    });
    const serverInfo = (initResult as { serverInfo?: { name?: unknown; version?: unknown } })?.serverInfo;
    const protocolVersion = (initResult as { protocolVersion?: unknown })?.protocolVersion;
    this.serverIdentity = {
      name: typeof serverInfo?.name === 'string' ? serverInfo.name : undefined,
      version: typeof serverInfo?.version === 'string' ? serverInfo.version : undefined,
      protocolVersion: typeof protocolVersion === 'string' ? protocolVersion : undefined,
    };
    const label = serverInfo?.name ?? this.agentConfig.url ?? '?';
    log.info(`MCP connected: ${label} v${serverInfo?.version ?? '?'}`);
    this.remoteTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    const toolsResult = await this.sendRequest('tools/list', {}) as { tools?: MCPToolDef[] };
    this.storeTools(toolsResult?.tools ?? []);
    this.initialized = true;
    log.info(`MCP [${label}] tools: ${this.getTools().map(t => t.name).join(', ') || '(none)'}`);
  }

  async close(): Promise<void> {
    if (this.remoteTransport) await this.remoteTransport.close();
    return super.close();
  }

  /**
   * Agent view of the discovered tools.
   *
   * The leaf stores the same runtime shape under its own descriptor type
   * (`inputSchema` always normalised to an object); the agent's
   * `MCPDiscoveredTool` adds stricter `annotations`. One cast lives here, at the
   * single boundary between the two declarations.
   */
  override getTools(): MCPToolDef[] {
    return super.getTools() as unknown as MCPToolDef[];
  }

  /** @internal subclass hook so the remote path stores the agent descriptor type. */
  protected override storeTools(tools: MCPToolDef[]): void {
    super.storeTools(tools as unknown as Parameters<MCPStdioClient['storeTools']>[0]);
  }

  /** Agent-specific: honour toolPolicy when present. */
  async callTool(name: string, args: Record<string, unknown>, options: MCPCallOptions = {}): Promise<string> {
    const policy = this.agentConfig.toolPolicy;
    if (!policy || policy.allow === undefined || policy.allow.includes(name)) {
      return super.callTool(name, args, options);
    }
    throw new Error(`MCP tool "${name}" is not allowed by toolPolicy`);
  }
}

// ── Registry Integration ───────────────────────────────

export interface MCPServerRegistryRecord {
  id: string;
  command?: string;
  args: string[];
  url?: string;
  transport?: 'stdio' | 'sse' | 'streamable-http';
  headers?: Record<string, string>;
  env: Record<string, string>;
  toolPolicy?: MCPToolPolicy;
  adapterConfig?: MCPAdapterConfig;
}

/**
 * Convert a registry record to MCP client config.
 * Supports stdio (command), SSE, and streamable-http (url) transports.
 * Prefer explicit transport when set so remote verify is not forced through stdio.
 */
export function registryRecordToConfig(record: MCPServerRegistryRecord): MCPServerConfig | null {
  const transport = record.transport
    ?? (record.command ? 'stdio' : record.url ? 'sse' : undefined);
  if (!transport) return null;

  if (transport === 'stdio') {
    if (!record.command) return null;
    return {
      command: record.command,
      args: record.args.length > 0 ? record.args : undefined,
      env: Object.keys(record.env).length > 0 ? record.env : undefined,
      transport: 'stdio',
      serverId: record.id,
      toolPolicy: record.toolPolicy,
      adapterConfig: record.adapterConfig,
    };
  }

  if (!record.url) return null;
  return {
    url: record.url,
    transport,
    headers: record.headers && Object.keys(record.headers).length > 0 ? record.headers : undefined,
    serverId: record.id,
    toolPolicy: record.toolPolicy,
    adapterConfig: record.adapterConfig,
  };
}

// ── MCP Tool Bridge ─────────────────────────────────────

export class MCPToolBridge {
  private clients: MCPClient[] = [];
  private toolToClient = new Map<string, MCPClient>();
  private clientConfig = new Map<MCPClient, MCPServerConfig>();

  async connect(servers: MCPServerConfig[]): Promise<void> {
    const results = await Promise.allSettled(
      servers.map(async (config) => {
        const client = new MCPClient(config);
        await client.connect();
        return { client, config };
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        this.clients.push(result.value.client);
        this.clientConfig.set(result.value.client, result.value.config);
        for (const tool of result.value.client.getTools()) {
          if (this.toolToClient.has(tool.name)) {
            log.warn(
              `MCP tool name conflict: "${tool.name}" already registered from another server; skipping duplicate`,
            );
            continue;
          }
          this.toolToClient.set(tool.name, result.value.client);
        }
      } else {
        const reason = result.reason?.message ?? String(result.reason);
        log.warn(`MCP server connection failed: ${reason}`);
      }
    }
  }

  getToolDefs(): MCPToolDef[] {
    const defs: MCPToolDef[] = [];
    for (const client of this.clients) {
      defs.push(...client.getTools());
    }
    return defs;
  }

  getClient(toolName: string): MCPClient | undefined {
    return this.toolToClient.get(toolName);
  }

  getServerConfig(toolName: string): MCPServerConfig | undefined {
    const client = this.toolToClient.get(toolName);
    return client ? this.clientConfig.get(client) : undefined;
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.clients.map(c => c.close()));
    this.clients = [];
    this.toolToClient.clear();
    this.clientConfig.clear();
  }
}
