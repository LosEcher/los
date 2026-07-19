import { spawn, type ChildProcess } from 'node:child_process';
import { delimiter, dirname } from 'node:path';
import { getLogger } from '@los/infra/logger';

const log = getLogger('agent');
const STARTUP_GRACE_MS = 300;

export interface JSONRPCMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class MCPStdioTransport {
  private proc: ChildProcess | null = null;
  private handlers: Array<(message: JSONRPCMessage) => void> = [];
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
            const message = JSON.parse(trimmed) as JSONRPCMessage;
            for (const handler of this.handlers) handler(message);
          } catch {
            log.debug(`MCP [${this.command}] non-JSON: ${trimmed.slice(0, 120)}`);
          }
        }
      });

      this.proc.stderr?.on('data', (data: Buffer) => {
        log.debug(`MCP stderr [${this.command}]: ${data.toString('utf-8').trim().slice(0, 300)}`);
      });

      this.proc.on('error', (error) => {
        if (this.closed) return;
        reject(new Error(`MCP process error [${this.command}]: ${error.message}`));
      });

      this.proc.on('exit', (code, signal) => {
        if (this.closed) return;
        log.warn(`MCP server [${this.command}] exited code=${code} signal=${signal}`);
        for (const handler of this.handlers) {
          handler({
            jsonrpc: '2.0',
            error: { code: -32000, message: `MCP server exited: ${this.command}` },
          });
        }
      });

      setTimeout(resolve, STARTUP_GRACE_MS);
    });
  }

  send(message: JSONRPCMessage): void {
    if (!this.proc || this.closed) throw new Error('MCP transport not connected');
    this.proc.stdin!.write(`${JSON.stringify(message)}\n`);
  }

  onMessage(handler: (message: JSONRPCMessage) => void): void {
    this.handlers.push(handler);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.handlers = [];
    if (!this.proc) return;

    this.proc.stdin?.end();
    this.proc.kill('SIGTERM');
    setTimeout(() => {
      if (this.proc && !this.proc.killed) this.proc.kill('SIGKILL');
    }, 2_000).unref();
    this.proc = null;
  }
}

function buildMCPProcessEnv(env?: Record<string, string>): NodeJS.ProcessEnv {
  const nodeBinDir = dirname(process.execPath);
  const pathEntries = new Set([
    nodeBinDir,
    ...(env?.PATH ?? '').split(delimiter).filter(Boolean),
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean),
  ]);
  return {
    ...process.env,
    ...env,
    PATH: [...pathEntries].join(delimiter),
  };
}
