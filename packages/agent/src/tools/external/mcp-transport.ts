/**
 * MCP Transport interface — abstract transport layer for MCP clients.
 *
 * LOS currently supports three transports:
 *   - stdio: child process stdin/stdout (local MCP servers)
 *   - sse: Server-Sent Events (remote MCP servers)
 *   - streamable-http: Streamable HTTP (MCP spec 2025+)
 *
 * All transports implement the same JSON-RPC message interface.
 * MCPClient is transport-agnostic beyond construction.
 */

/**
 * The JSON-RPC envelope is defined by the leaf stdio package so both sides of the
 * extraction describe the protocol identically.
 */
import type { JSONRPCMessage } from '@los/mcp-stdio';

export type { JSONRPCMessage };

export interface MCPTransport {
  /** Start the transport connection. */
  start(): Promise<void>;

  /** Send a JSON-RPC message to the server. */
  send(message: JSONRPCMessage): void;

  /** Register a handler for incoming JSON-RPC messages. */
  onMessage(handler: (message: JSONRPCMessage) => void): void;

  /** Close the transport and clean up resources. */
  close(): Promise<void>;
}
