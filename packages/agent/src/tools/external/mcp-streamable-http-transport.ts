/**
 * MCP Streamable HTTP Transport — bidirectional HTTP with session management.
 *
 * Per MCP spec (2025+):
 *   - Client POSTs JSON-RPC messages to a single endpoint.
 *   - Server responds with JSON (simple) or SSE stream (streaming).
 *   - Session management via `Mcp-Session-Id` header.
 *   - Supports resumability via `Last-Event-Id`.
 */

import { getLogger } from '@los/infra/logger';
import type { MCPTransport } from './mcp-transport.js';
import type { JSONRPCMessage } from './mcp-stdio-transport.js';

const log = getLogger('agent');
const REQUEST_TIMEOUT_MS = 60_000;

export class MCPStreamableHTTPTransport implements MCPTransport {
  private handlers: Array<(message: JSONRPCMessage) => void> = [];
  private closed = false;
  private url: string;
  private headers: Record<string, string>;
  private sessionId: string | undefined;
  private lastEventId: string | undefined;
  private sseReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private sseAbort: AbortController | null = null;

  constructor(
    url: string,
    headers?: Record<string, string>,
  ) {
    this.url = url.replace(/\/$/, '');
    this.headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...headers,
    };
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('MCP streamable-http transport closed');

    // For streamable HTTP, we don't need a persistent connection at start.
    // The connection is established per-request. However, the initialize
    // request will set up the session.
  }

  send(message: JSONRPCMessage): void {
    if (this.closed) throw new Error('MCP streamable-http transport closed');

    const body = JSON.stringify(message);
    const reqHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };

    if (this.sessionId) {
      reqHeaders['Mcp-Session-Id'] = this.sessionId;
    }
    if (this.lastEventId) {
      reqHeaders['Last-Event-ID'] = this.lastEventId;
    }

    // Merge custom headers (lower priority than MCP-specific headers).
    // reqHeaders uses canonical casing; normalize for comparison.
    for (const [k, v] of Object.entries(this.headers)) {
      const lower = k.toLowerCase();
      if (lower === 'content-type' || lower === 'accept' || lower === 'mcp-session-id' || lower === 'last-event-id') {
        continue; // MCP-managed headers take priority
      }
      if (reqHeaders[k] === undefined) {
        reqHeaders[k] = v;
      }
    }

    fetch(this.url, {
      method: 'POST',
      headers: reqHeaders,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).then(async (res) => {
      // Capture session ID from response
      const newSessionId = res.headers.get('mcp-session-id');
      if (newSessionId) this.sessionId = newSessionId;

      const contentType = res.headers.get('content-type') ?? '';

      if (contentType.includes('text/event-stream')) {
        // SSE streaming response — process the stream
        await this.processSSEResponse(res);
      } else if (!res.ok) {
        const text = await res.text().catch(() => '');
        log.warn(`MCP streamable-http POST ${res.status}: ${text.slice(0, 200)}`);
      } else {
        // JSON response
        try {
          const msg = await res.json() as JSONRPCMessage;
          for (const handler of this.handlers) {
            handler(msg);
          }
        } catch {
          const text = await res.text().catch(() => '');
          log.debug(`MCP streamable-http non-JSON response: ${text.slice(0, 200)}`);
        }
      }
    }).catch((err) => {
      if (!this.closed) {
        log.warn(`MCP streamable-http POST failed: ${(err as Error).message}`);
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
    this.sseAbort?.abort();
    this.sseReader?.cancel().catch(() => {});
    this.sseReader = null;
    this.sseAbort = null;
    this.sessionId = undefined;
  }

  // ── SSE response processing ───────────────────────────

  private async processSSEResponse(response: Response): Promise<void> {
    if (!response.body) return;

    this.sseReader?.cancel().catch(() => {});
    this.sseAbort?.abort();
    this.sseAbort = new AbortController();
    this.sseReader = response.body.getReader();

    const decoder = new TextDecoder();
    let buffer = '';
    let eventType = '';
    let dataLines: string[] = [];

    try {
      while (!this.closed) {
        const { done, value } = await this.sseReader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('id: ')) {
            this.lastEventId = line.slice(4).trim();
          } else if (line.startsWith('data: ')) {
            dataLines.push(line.slice(6));
          } else if (line === '') {
            if (dataLines.length > 0) {
              this.dispatchEvent(eventType, dataLines.join('\n'));
            }
            eventType = '';
            dataLines = [];
          }
        }
      }
    } catch (err) {
      if (!this.closed) {
        log.debug(`MCP streamable-http SSE stream ended: ${(err as Error).message}`);
      }
    }
  }

  private dispatchEvent(eventType: string, data: string): void {
    if (eventType && eventType !== 'message') return;
    try {
      const msg = JSON.parse(data) as JSONRPCMessage;
      for (const handler of this.handlers) {
        handler(msg);
      }
    } catch {
      log.debug(`MCP streamable-http non-JSON event: ${data.slice(0, 120)}`);
    }
  }
}
