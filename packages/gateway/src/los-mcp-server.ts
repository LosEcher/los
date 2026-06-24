/**
 * @los/gateway los-mcp-server — los capabilities exposed as MCP tools.
 *
 * External agents (Claude Code, Codex, etc.) can configure this as an
 * MCP server and call los tools directly:
 *
 *   - los.memory.search   — search los memory store
 *   - los.task.status     — check task run status
 *   - los.task.list       — list session task runs
 *   - los.operator.escalate — escalate to human operator
 *   - los.tool.gate.check — pre-check a tool call (same as /operator/tool-gate)
 *
 * The server speaks the MCP stdio JSON-RPC protocol, so it can be used
 * with any MCP-compatible client (Claude Code, Claude Desktop, Codex, etc.).
 *
 * Claude Code config example (~/.claude/mcp.json):
 *   {
 *     "mcpServers": {
 *       "los": {
 *         "command": "node",
 *         "args": ["packages/gateway/dist/los-mcp-server.js"],
 *         "env": { "LOS_GATEWAY_URL": "http://localhost:8080" }
 *       }
 *     }
 *   }
 */

import { randomUUID } from 'node:crypto';

// ── Config ─────────────────────────────────────────────────────────

const GATEWAY_URL = process.env.LOS_GATEWAY_URL ?? 'http://localhost:8080';
const PROTOCOL_VERSION = '2024-11-05';

// ── Types ──────────────────────────────────────────────────────────

interface JSONRPCMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

interface MCPToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ── Tool definitions ───────────────────────────────────────────────

const TOOLS: MCPToolDef[] = [
  {
    name: 'los.memory.search',
    description: 'Search the los memory store for relevant observations, reflections, and patterns.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query text or keywords' },
        limit: { type: 'number', description: 'Max results (default 10)', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'los.task.status',
    description: 'Get the current status of a los task run.',
    inputSchema: {
      type: 'object',
      properties: {
        taskRunId: { type: 'string', description: 'Task run ID' },
      },
      required: ['taskRunId'],
    },
  },
  {
    name: 'los.task.list',
    description: 'List task runs for a session.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID' },
        limit: { type: 'number', description: 'Max results (default 10)', default: 10 },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'los.operator.escalate',
    description: 'Escalate a decision to a human operator via the los handoff system. Use when the agent needs approval for a high-risk action or is stuck.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID' },
        reason: { type: 'string', description: 'Why escalation is needed' },
        toolCallId: { type: 'string', description: 'Tool call ID being escalated (optional)' },
        urgency: { type: 'string', description: 'low | medium | high', enum: ['low', 'medium', 'high'] },
      },
      required: ['sessionId', 'reason'],
    },
  },
  {
    name: 'los.tool.gate.check',
    description: 'Pre-check whether a tool call is safe to execute. Returns allow/deny with reasoning.',
    inputSchema: {
      type: 'object',
      properties: {
        toolName: { type: 'string', description: 'Tool name (e.g., "Bash", "Write")' },
        args: { type: 'object', description: 'Tool arguments' },
        sessionId: { type: 'string', description: 'Session ID' },
      },
      required: ['toolName', 'sessionId'],
    },
  },
];

// ── Tool implementations ───────────────────────────────────────────

async function callLosApi(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`los API error ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.json();
}

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'los.memory.search': {
      // GET /memory supports ?q= and ?limit= query params
      const q = encodeURIComponent(String(args.query ?? ''));
      const limit = Number(args.limit ?? 10);
      const result = await fetch(`${GATEWAY_URL}/memory?q=${q}&limit=${limit}`);
      if (!result.ok) return `Memory search failed (${result.status})`;
      return JSON.stringify(await result.json(), null, 2);
    }

    case 'los.task.status': {
      const result = await fetch(`${GATEWAY_URL}/tasks/${args.taskRunId}`);
      if (!result.ok) return `Task ${args.taskRunId} not found (${result.status})`;
      return JSON.stringify(await result.json(), null, 2);
    }

    case 'los.task.list': {
      const result = await fetch(`${GATEWAY_URL}/tasks?sessionId=${args.sessionId}&limit=${args.limit ?? 10}`);
      if (!result.ok) return `Failed to list tasks (${result.status})`;
      return JSON.stringify(await result.json(), null, 2);
    }

    case 'los.operator.escalate': {
      const sessionId = String(args.sessionId ?? '');
      const res = await fetch(`${GATEWAY_URL}/sessions/${encodeURIComponent(sessionId)}/operator-events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'steering',
          instruction: `MCP escalation: ${args.reason}${args.toolCallId ? ` (callId: ${args.toolCallId})` : ''}`,
          actor: 'mcp-client',
          reason: 'agent_escalation',
        }),
      });
      if (!res.ok) return `Escalation failed (${res.status}): ${await res.text().catch(() => '')}`;
      return JSON.stringify({ escalated: true }, null, 2);
    }

    case 'los.tool.gate.check': {
      const result = await callLosApi('/operator/tool-gate', {
        callId: randomUUID(),
        toolName: args.toolName,
        args: args.args ?? {},
        sessionId: args.sessionId,
        source: 'mcp-client',
      });
      return JSON.stringify(result, null, 2);
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// ── MCP stdio server ───────────────────────────────────────────────

let requestId = 0;
const pendingRequests = new Map<number, (response: JSONRPCMessage) => void>();

function send(message: JSONRPCMessage): void {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function handleRequest(msg: JSONRPCMessage): void {
  const id = msg.id;
  const method = msg.method;
  const params = msg.params ?? {};

  switch (method) {
    case 'initialize': {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: {
            name: 'los-mcp-server',
            version: '0.1.0',
          },
        },
      });
      break;
    }

    case 'tools/list': {
      send({
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS },
      });
      break;
    }

    case 'tools/call': {
      const toolName = params.name as string;
      const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
      handleToolCall(toolName, toolArgs).then(
        (text) => {
          send({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text }],
            },
          });
        },
        (err: Error) => {
          send({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: `Error: ${err.message}` }],
              isError: true,
            },
          });
        },
      );
      break;
    }

    default: {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    }
  }
}

function main(): void {
  const stdin = process.stdin;
  let buffer = '';

  stdin.setEncoding('utf-8');
  stdin.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JSONRPCMessage;
        if (msg.jsonrpc !== '2.0') continue;
        // Notifications (no id)
        if (msg.method === 'notifications/initialized') {
          // Client sent initialized notification — ready to serve
          continue;
        }
        if (msg.id !== undefined) {
          handleRequest(msg);
        }
      } catch {
        // Skip unparseable lines
      }
    }
  });

  stdin.on('end', () => {
    process.exit(0);
  });

  // Prevent EPIPE on stdout
  process.stdout.on('error', () => {
    process.exit(0);
  });

  // stderr for logging only (stdout is the MCP transport)
  console.error(`los MCP server ready (gateway: ${GATEWAY_URL})`);
}

main();
