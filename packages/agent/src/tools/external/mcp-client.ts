/**
 * @los/agent/tools/mcp-client — MCP (Model Context Protocol) client.
 *
 * Connects to MCP servers via stdio transport, discovers their tools,
 * and routes tool calls through the JSON-RPC protocol.
 *
 * Supports any MCP-compatible server: filesystem, github, puppeteer,
 * memory, databases, Composio, etc.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { delimiter, dirname } from 'node:path';
import { getLogger } from '@los/infra/logger';
import type { MCPToolPolicy } from '../../mcp-distribution-policy.js';

const log = getLogger('agent');

// ── Public Types ─────────────────────────────────────────

export interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  serverId?: string;
  toolPolicy?: MCPToolPolicy;
}

export interface MCPToolDef {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

// ── Internal JSON-RPC Types ─────────────────────────────

interface JSONRPCMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface MCPToolCallResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

// ── Constants ───────────────────────────────────────────

const MCP_PROTOCOL_VERSION = '2024-11-05';
const REQUEST_TIMEOUT_MS = 60_000;
const STARTUP_GRACE_MS = 300;

// ── Stdio Transport ─────────────────────────────────────

class MCPStdioTransport {
  private proc: ChildProcess | null = null;
  private handlers: Array<(msg: JSONRPCMessage) => void> = [];
  private buffer = '';
  private closed = false;

  constructor(
    private command: string,
    private args: string[],
    private env?: Record<string, string>,
  ) {}

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.proc = spawn(this.command, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildMCPProcessEnv(this.env),
      });

      this.proc.stdout!.on('data', (chunk: Buffer) => {
        if (this.closed) return;
        this.buffer += chunk.toString('utf-8');
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed) as JSONRPCMessage;
            for (const handler of this.handlers) {
              handler(msg);
            }
          } catch {
            // Non-JSON lines from MCP servers are typically logs; safe to skip
            log.debug(`MCP [${this.command}] non-JSON: ${trimmed.slice(0, 120)}`);
          }
        }
      });

      this.proc.stderr?.on('data', (data: Buffer) => {
        log.debug(`MCP stderr [${this.command}]: ${data.toString('utf-8').trim().slice(0, 300)}`);
      });

      this.proc.on('error', (err) => {
        if (this.closed) return;
        reject(new Error(`MCP process error [${this.command}]: ${err.message}`));
      });

      this.proc.on('exit', (code, signal) => {
        if (!this.closed) {
          log.warn(`MCP server [${this.command}] exited code=${code} signal=${signal}`);
          // Reject all pending handlers
          for (const handler of this.handlers) {
            handler({
              jsonrpc: '2.0',
              error: { code: -32000, message: `MCP server exited: ${this.command}` },
            });
          }
        }
      });

      // Grace period for process startup before the handshake
      setTimeout(() => resolve(), STARTUP_GRACE_MS);
    });
  }

  send(msg: JSONRPCMessage): void {
    if (!this.proc || this.closed) {
      throw new Error('MCP transport not connected');
    }
    this.proc.stdin!.write(JSON.stringify(msg) + '\n');
  }

  onMessage(handler: (msg: JSONRPCMessage) => void): void {
    this.handlers.push(handler);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.handlers = [];
    if (this.proc) {
      this.proc.stdin?.end();
      this.proc.kill('SIGTERM');
      // Force kill after 2s if still alive
      setTimeout(() => {
        if (this.proc && !this.proc.killed) {
          this.proc.kill('SIGKILL');
        }
      }, 2000).unref();
      this.proc = null;
    }
  }
}

function buildMCPProcessEnv(env?: Record<string, string>): NodeJS.ProcessEnv {
  const nodeBinDir = dirname(process.execPath);
  const basePath = process.env.PATH ?? '';
  const configuredPath = env?.PATH ?? '';
  const pathEntries = new Set([
    nodeBinDir,
    ...configuredPath.split(delimiter).filter(Boolean),
    ...basePath.split(delimiter).filter(Boolean),
  ]);
  return {
    ...process.env,
    ...env,
    PATH: [...pathEntries].join(delimiter),
  };
}

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

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.initialized) {
      throw new Error(`MCP client not initialized: ${this.config.command}`);
    }
    const result = await this.sendRequest('tools/call', {
      name,
      arguments: args,
    }) as MCPToolCallResult;

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

  private sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timeout: ${method} (${REQUEST_TIMEOUT_MS}ms)`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
        timer,
      });

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
