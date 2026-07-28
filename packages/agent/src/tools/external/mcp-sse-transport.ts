/**
 * MCP SSE Transport — connects to remote MCP servers via Server-Sent Events.
 *
 * Architecture (per MCP spec 2024-11-05):
 *   - Client opens a GET connection to the SSE endpoint.
 *   - Server pushes JSON-RPC messages as SSE events (event: message).
 *   - Client sends JSON-RPC messages via HTTP POST to the same base URL.
 *   - The POST endpoint may be the same URL or a dedicated one (default: same).
 */

import { getLogger } from '@los/infra/logger';
import type { MCPTransport } from './mcp-transport.js';
import type { JSONRPCMessage } from './mcp-stdio-transport.js';

const log = getLogger('agent');
const RECONNECT_DELAY_MS = 1_000;
const SSE_READ_TIMEOUT_MS = 30_000;

export class MCPSSETransport implements MCPTransport {
  private handlers: Array<(message: JSONRPCMessage) => void> = [];
  private eventSource: AbortController | null = null;
  private closed = false;
  private baseUrl: string;
  private endpoint: string;
  private headers: Record<string, string>;
  private lastEventId: string | undefined;

  constructor(
    url: string,
    headers?: Record<string, string>,
  ) {
    // The SSE endpoint. For MCP, this is typically the GET endpoint that
    // returns text/event-stream. Messages are sent via POST to the same URL.
    this.baseUrl = url.replace(/\/$/, '');
    this.endpoint = url;
    this.headers = {
      'Accept': 'text/event-stream',
      'Content-Type': 'application/json',
      ...headers,
    };
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('MCP SSE transport closed');
    await this.connectSSE();
  }

  send(message: JSONRPCMessage): void {
    if (!this.baseUrl || this.closed) {
      throw new Error('MCP SSE transport not connected');
    }

    // Send JSON-RPC via HTTP POST (fire-and-forget for notifications,
    // response handled by SSE stream for requests).
    const body = JSON.stringify(message);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.headers,
    };
    // Don't set Accept on POST — it's a standard JSON request
    delete headers['Accept'];

    fetch(this.baseUrl, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(SSE_READ_TIMEOUT_MS),
    }).then(async (res) => {
      if (!res.ok && res.status !== 202) {
        // For POST responses: the server may return a direct JSON-RPC response
        // (streamable-http style) or just 202 Accepted (pure SSE style).
        const text = await res.text().catch(() => '');
        log.debug(`MCP SSE POST ${res.status}: ${text.slice(0, 200)}`);
      }
    }).catch((err) => {
      if (!this.closed) {
        log.warn(`MCP SSE POST failed: ${(err as Error).message}`);
      }
    });
  }

  onMessage(handler: (message: JSONRPCMessage) => void): void {
    this.handlers.push(handler);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.handlers = [];
    this.eventSource?.abort();
    this.eventSource = null;
  }

  // ── SSE connection ────────────────────────────────────

  private async connectSSE(): Promise<void> {
    this.eventSource?.abort();
    this.eventSource = new AbortController();

    const headers: Record<string, string> = { ...this.headers };
    if (this.lastEventId) {
      headers['Last-Event-ID'] = this.lastEventId;
    }

    try {
      const response = await fetch(this.endpoint, {
        method: 'GET',
        headers,
        signal: this.eventSource.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
      }

      log.info(`MCP SSE connected to ${this.endpoint}`);

      // Parse SSE stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (!this.closed) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        let eventType = '';
        let dataLines: string[] = [];

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('id: ')) {
            this.lastEventId = line.slice(4).trim();
          } else if (line.startsWith('data: ')) {
            dataLines.push(line.slice(6));
          } else if (line === '') {
            // Empty line = event boundary
            if (dataLines.length > 0) {
              this.dispatchSSEEvent(eventType, dataLines.join('\n'));
            }
            eventType = '';
            dataLines = [];
          }
        }
      }

      // Reconnect on stream end (unless closed)
      if (!this.closed) {
        log.warn('MCP SSE stream ended, reconnecting...');
        await new Promise(r => setTimeout(r, RECONNECT_DELAY_MS));
        await this.connectSSE();
      }
    } catch (err) {
      if (!this.closed) {
        log.warn(`MCP SSE error: ${(err as Error).message}, reconnecting...`);
        await new Promise(r => setTimeout(r, RECONNECT_DELAY_MS));
        await this.connectSSE();
      }
    }
  }

  private dispatchSSEEvent(eventType: string, data: string): void {
    // MCP SSE events: 'message' event type carries JSON-RPC messages
    if (eventType && eventType !== 'message') {
      // Non-standard event — ignore for MCP (endpoint, ping, etc.)
      return;
    }
    try {
      const message = JSON.parse(data) as JSONRPCMessage;
      for (const handler of this.handlers) {
        handler(message);
      }
    } catch {
      log.debug(`MCP SSE non-JSON event data: ${data.slice(0, 120)}`);
    }
  }
}
