/**
 * @los/mcp-stdio/client — minimal stdio MCP client.
 *
 * The API surface is intentionally the subset that a non-agent consumer needs:
 * `connect()`, `getTools()`, `getServerIdentity()`, `callTool()`, `close()`.
 * It knows nothing about `@los/agent`'s tool policy, the cantool capability
 * adapter, or remote transports — those stay in `@los/agent`, which delegates
 * its stdio path here.
 *
 * Why this exists: `@los/memory` used to import `MCPClient` from `@los/agent`
 * while `@los/agent` depends on memory for the read model — a layering inversion.
 * A leaf package both sides can depend on removes the cycle without moving the
 * agent-specific policy out of the agent.
 */

import { getLogger } from '@los/infra/logger';
import { MCPStdioTransport, type JSONRPCMessage } from './stdio-transport.js';

const log = getLogger('mcp-stdio');

/** Protocol version advertised in the initialize handshake. */
export const MCP_PROTOCOL_VERSION = '2024-11-05';

/** Per-request timeout. Long enough for a cold language server to answer. */
export const MCP_REQUEST_TIMEOUT_MS = 60_000;

export interface MCPServerConfig {
  /** stdio command (local servers). Required for the stdio transport. */
  command: string;
  args?: string[];
  env?: Record<string, string>;
  serverId?: string;
}

export interface MCPToolDef {
  name: string;
  description?: string;
  /**
   * Normalised to `{}` when the server omits it, so consumers can rely on the
   * field being present without every call site re-checking the wire shape.
   */
  inputSchema: Record<string, unknown>;
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

export class MCPStdioClient {
  private transport: MCPStdioTransport;
  private requestId = 0;
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  // Protected, not private: `@los/agent` subclasses this client to add remote
  // transports and agent-only policy, and needs to drive the same pending map.
  protected tools: MCPToolDef[] = [];
  protected serverIdentity: MCPServerIdentity = {};
  protected initialized = false;

  constructor(private config: MCPServerConfig) {
    if (!config.command) throw new Error('MCP stdio transport requires a command');
    this.transport = new MCPStdioTransport(config.command, config.args ?? [], config.env);
    this.transport.onMessage((msg) => this.handleMessage(msg));
  }

  async connect(): Promise<void> {
    await this.transport.start();

    const initResult = await this.sendRequest('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
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
    const label = serverInfo?.name ?? this.config.command;
    log.info(`MCP connected: ${label} v${serverInfo?.version ?? '?'}`);

    this.sendNotification('notifications/initialized', {});

    const toolsResult = await this.sendRequest('tools/list', {}) as { tools?: MCPToolDef[] };
    this.storeTools((toolsResult?.tools ?? []).map(tool => ({
      ...tool,
      inputSchema: tool.inputSchema ?? {},
    })));
    this.initialized = true;
    log.info(`MCP [${label}] tools: ${this.tools.map(t => t.name).join(', ') || '(none)'}`);
  }

  getTools(): MCPToolDef[] {
    return this.tools;
  }

  /**
   * Protected so a subclass with a richer descriptor (the agent's
   * `MCPDiscoveredTool`) can store its own type here and override `getTools()`.
   */
  protected storeTools(tools: MCPToolDef[]): void {
    this.tools = tools;
  }

  getServerIdentity(): MCPServerIdentity {
    return { ...this.serverIdentity };
  }

  async callTool(name: string, args: Record<string, unknown>, options: MCPCallOptions = {}): Promise<string> {
    if (!this.initialized) {
      throw new Error(`MCP client not initialized: ${this.config.command}`);
    }
    const result = await this.sendRequest('tools/call', { name, arguments: args }, options) as MCPToolCallResult;
    const text = (result.content ?? [])
      .map(c => {
        if (c.type === 'text' && c.text !== undefined) return c.text;
        if (c.type === 'resource' && c.text !== undefined) return c.text;
        return JSON.stringify(c);
      })
      .join('\n');
    if (result.isError) throw new Error(`MCP tool error [${name}]: ${text}`);
    return text;
  }

  async close(): Promise<void> {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('MCP client closed'));
    }
    this.pending.clear();
    await this.transport.close();
  }

  protected sendRequest(
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
        reject(new Error(`MCP request timeout: ${method} (${MCP_REQUEST_TIMEOUT_MS}ms)`));
      }, MCP_REQUEST_TIMEOUT_MS);

      const onAbort = () => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        removeAbortListener();
        this.sendNotification('notifications/cancelled', { requestId: id, reason: 'client_cancelled' });
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

  protected handleMessage(msg: JSONRPCMessage): void {
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
