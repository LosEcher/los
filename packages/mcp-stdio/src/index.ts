/**
 * @los/mcp-stdio — leaf stdio MCP client shared by `@los/agent` and `@los/memory`.
 *
 * Dependency direction: this package depends on `@los/infra` (logger) and Node
 * built-ins only. Consumers depend on it; it depends on no consumer. That is what
 * lets memory drop its production dependency on `@los/agent` without duplicating
 * the transport.
 */

export {
  MCPStdioClient,
  MCP_PROTOCOL_VERSION,
  MCP_REQUEST_TIMEOUT_MS,
  type MCPCallOptions,
  type MCPServerConfig,
  type MCPServerIdentity,
  type MCPToolDef,
} from './client.js';
export { MCPStdioTransport, type JSONRPCMessage } from './stdio-transport.js';
