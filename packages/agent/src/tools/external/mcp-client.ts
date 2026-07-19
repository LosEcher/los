/**
 * @los/agent/tools/mcp-client — MCP (Model Context Protocol) client.
 *
 * Connects to MCP servers via stdio transport, discovers their tools,
 * and routes tool calls through the JSON-RPC protocol.
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
import {
  MCPStdioTransport,
  type JSONRPCMessage,
} from './mcp-stdio-transport.js';

const log = getLogger('agent');

// ── Public Types ─────────────────────────────────────────

export interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  serverId?: string;
  toolPolicy?: MCPToolPolicy;
  adapterConfig?: MCPAdapterConfig;
}

export interface MCPToolDef extends MCPDiscoveredTool {}

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
// ── MCP Client ──────────────────────────────────────────

export class MCPClient {
  private transport: MCPStdioTransport;
  private requestId = 0;
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private tools: MCPToolDef[] = [];
  private serverIdentity: MCPServerIdentity = {};
  private initialized = false;

  constructor(private config: MCPServerConfig) {
    this.transport = new MCPStdioTransport(
      config.command,
      config.args ?? [],
      config.env,
    );
    this.transport.onMessage((msg) => this.handleMessage(msg));
  }

  async connect(): Promise<void> {
    await this.transport.start();

    // ── Initialize handshake ──────────────────────────────
    const initResult = await this.sendRequest('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: { name: 'los', version: '0.1.0' },
    });
    const serverInfo = (initResult as any)?.serverInfo;
    this.serverIdentity = {
      name: typeof serverInfo?.name === 'string' ? serverInfo.name : undefined,
      version: typeof serverInfo?.version === 'string' ? serverInfo.version : undefined,
      protocolVersion: typeof (initResult as any)?.protocolVersion === 'string'
        ? (initResult as any).protocolVersion
        : undefined,
    };
    log.info(`MCP connected: ${serverInfo?.name ?? this.config.command} v${serverInfo?.version ?? '?'}`);

    // Send initialized notification
    this.sendNotification('notifications/initialized', {});

    // ── Discover tools ────────────────────────────────────
    const toolsResult = await this.sendRequest('tools/list', {});
    this.tools = (toolsResult as any)?.tools ?? [];
    this.initialized = true;
    log.info(
      `MCP [${this.config.command}] tools: ${this.tools.map(t => t.name).join(', ') || '(none)'}`,
    );
  }

  getTools(): MCPToolDef[] {
    return this.tools;
  }

  getServerIdentity(): MCPServerIdentity {
    return { ...this.serverIdentity };
  }

  async callTool(name: string, args: Record<string, unknown>, options: MCPCallOptions = {}): Promise<string> {
    if (!this.initialized) {
      throw new Error(`MCP client not initialized: ${this.config.command}`);
    }
    const result = await this.sendRequest('tools/call', {
      name,
      arguments: args,
    }, options) as MCPToolCallResult;

    const text = result.content
      .map(c => {
        if (c.type === 'text' && c.text !== undefined) return c.text;
        if (c.type === 'resource' && c.text !== undefined) return c.text;
        return JSON.stringify(c);
      })
      .join('\n');

    if (result.isError) {
      throw new Error(`MCP tool error [${name}]: ${text}`);
    }

    return text;
  }

  async close(): Promise<void> {
    // Reject all pending requests
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('MCP client closed'));
    }
    this.pending.clear();
    await this.transport.close();
  }

  // ── JSON-RPC helpers ──────────────────────────────────

  private sendRequest(
    method: string,
    params: Record<string, unknown>,
    options: MCPCallOptions = {},
  ): Promise<unknown> {
    const id = ++this.requestId;
    if (options.signal?.aborted) {
      return Promise.reject(new Error(`MCP request cancelled: ${method}`));
    }
    return new Promise((resolve, reject) => {
      const removeAbortListener = () => options.signal?.removeEventListener('abort', onAbort);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        removeAbortListener();
        reject(new Error(`MCP request timeout: ${method} (${REQUEST_TIMEOUT_MS}ms)`));
      }, REQUEST_TIMEOUT_MS);

      const onAbort = () => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        removeAbortListener();
        this.sendNotification('notifications/cancelled', {
          requestId: id,
          reason: 'client_cancelled',
        });
        reject(new Error(`MCP request cancelled: ${method}`));
      };

      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); removeAbortListener(); resolve(value); },
        reject: (err) => { clearTimeout(timer); removeAbortListener(); reject(err); },
        timer,
      });
      options.signal?.addEventListener('abort', onAbort, { once: true });

      this.transport.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    this.transport.send({ jsonrpc: '2.0', method, params });
  }

  private handleMessage(msg: JSONRPCMessage): void {
    // Notifications and responses without an id are ignored
    if (msg.id === undefined || msg.id === null) return;

    const numericId = typeof msg.id === 'string' ? Number(msg.id) : msg.id;
    if (!Number.isFinite(numericId)) return;

    const entry = this.pending.get(numericId);
    if (!entry) return;

    clearTimeout(entry.timer);
    this.pending.delete(numericId);

    if (msg.error) {
      entry.reject(new Error(`MCP error: ${msg.error.message} (code ${msg.error.code})`));
    } else {
      entry.resolve(msg.result);
    }
  }
}

// ── Registry Integration ───────────────────────────────

export interface MCPServerRegistryRecord {
  id: string;
  command?: string;
  args: string[];
  url?: string;
  env: Record<string, string>;
  toolPolicy?: MCPToolPolicy;
  adapterConfig?: MCPAdapterConfig;
}

/**
 * Convert a registry record to MCP client config.
 * Returns null if the record has no usable connection info.
 */
export function registryRecordToConfig(record: MCPServerRegistryRecord): MCPServerConfig | null {
  if (record.command) {
    return {
      command: record.command,
      args: record.args.length > 0 ? record.args : undefined,
      env: Object.keys(record.env).length > 0 ? record.env : undefined,
      serverId: record.id,
      toolPolicy: record.toolPolicy,
      adapterConfig: record.adapterConfig,
    };
  }
  // SSE / streamable-http remote servers are not yet implemented;
  // return null so the caller can skip them gracefully.
  return null;
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
