/**
 * @los/gateway/routes/acp — Agent Client Protocol (ACP) endpoint.
 *
 * Implements the ACP v1 JSON-RPC 2.0 protocol over HTTP, enabling
 * Zed, JetBrains, and other ACP-compatible editors to drive los agent
 * sessions.
 *
 * Reference: https://agentclientprotocol.com/
 *
 * Supported methods:
 *  - initialize       — handshake & capability negotiation
 *  - session/new      — create a new agent session
 *  - session/prompt   — send a user prompt to an existing session
 *  - session/cancel   — cancel the current turn
 *
 * Wire format: JSON-RPC 2.0 over HTTP POST (Content-Type: application/json).
 */

import type { FastifyInstance } from 'fastify';
import { getLogger } from '@los/infra/logger';

const log = getLogger('gateway:acp');

// ── ACP JSON-RPC types ─────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// ── ACP capability types ───────────────────────────────

interface AcpCapabilities {
  prompt: { supported: boolean };
  tools: { supported: boolean };
  toolApproval: { supported: boolean };
  streaming: { supported: boolean };
  cancellation: { supported: boolean };
}

interface AcpInitializeResult {
  protocolVersion: string;
  serverInfo: { name: string; version: string };
  capabilities: AcpCapabilities;
}

interface AcpSessionInfo {
  sessionId: string;
  status: 'idle' | 'running' | 'completed' | 'cancelled';
  createdAt: string;
}

// ── Error codes ─────────────────────────────────────────

const ACP_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SESSION_NOT_FOUND: -32000,
  SESSION_ALREADY_EXISTS: -32001,
  SESSION_NOT_IDLE: -32002,
} as const;

function jsonRpcError(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

function jsonRpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

// ── Session store (in-memory; production would use DB) ──

interface AcpSession {
  id: string;
  status: AcpSessionInfo['status'];
  createdAt: Date;
  /** los task-run ID, populated after dispatch. */
  losTaskRunId?: string;
  /** Abort controller for cancellation. */
  abortController: AbortController;
}

const sessions = new Map<string, AcpSession>();

function createSessionId(): string {
  const prefix = 'acp';
  const random = Math.random().toString(36).slice(2, 10);
  const timestamp = Date.now().toString(36);
  return `${prefix}-${timestamp}-${random}`;
}

// ── ACP method handlers ─────────────────────────────────

async function handleInitialize(
  params: Record<string, unknown> | undefined,
): Promise<AcpInitializeResult> {
  const clientInfo = params?.clientInfo as Record<string, unknown> | undefined;
  log.info(`ACP initialize from client: ${clientInfo?.name ?? 'unknown'} v${clientInfo?.version ?? '?'}`);

  return {
    protocolVersion: '2025-07-01',
    serverInfo: {
      name: 'los',
      version: '0.1.0',
    },
    capabilities: {
      prompt: { supported: true },
      tools: { supported: true },
      toolApproval: { supported: true },
      streaming: { supported: true },
      cancellation: { supported: true },
    },
  };
}

async function handleSessionNew(
  params: Record<string, unknown> | undefined,
): Promise<AcpSessionInfo> {
  const sessionId = createSessionId();
  const controller = new AbortController();
  const session: AcpSession = {
    id: sessionId,
    status: 'idle',
    createdAt: new Date(),
    abortController: controller,
  };
  sessions.set(sessionId, session);

  log.info(`ACP session created: ${sessionId}`);
  return {
    sessionId,
    status: 'idle',
    createdAt: session.createdAt.toISOString(),
  };
}

async function handleSessionPrompt(
  params: Record<string, unknown> | undefined,
): Promise<{ sessionId: string; status: string; message: string }> {
  const sessionId = params?.sessionId as string;
  const prompt = params?.prompt as string;
  if (!sessionId) throw Object.assign(new Error('sessionId is required'), { _acpCode: ACP_ERROR_CODES.INVALID_PARAMS });
  if (!prompt) throw Object.assign(new Error('prompt is required'), { _acpCode: ACP_ERROR_CODES.INVALID_PARAMS });

  const session = sessions.get(sessionId);
  if (!session) throw Object.assign(new Error(`Session not found: ${sessionId}`), { _acpCode: ACP_ERROR_CODES.SESSION_NOT_FOUND });
  if (session.status !== 'idle') throw Object.assign(new Error(`Session ${sessionId} is not idle (current: ${session.status})`), { _acpCode: ACP_ERROR_CODES.SESSION_NOT_IDLE });

  session.status = 'running';
  log.info(`ACP session ${sessionId}: processing prompt (${prompt.length} chars)`);

  // TODO: Dispatch to los agent execution pipeline.
  // For now, return an acknowledgement — the actual agent dispatch requires
  // wiring into the gateway's task orchestration layer (runScheduledAgentTask).
  return {
    sessionId,
    status: 'running',
    message: 'Prompt accepted. Agent execution will be dispatched.',
  };
}

async function handleSessionCancel(
  params: Record<string, unknown> | undefined,
): Promise<{ sessionId: string; status: string }> {
  const sessionId = params?.sessionId as string;
  if (!sessionId) throw Object.assign(new Error('sessionId is required'), { _acpCode: ACP_ERROR_CODES.INVALID_PARAMS });

  const session = sessions.get(sessionId);
  if (!session) throw Object.assign(new Error(`Session not found: ${sessionId}`), { _acpCode: ACP_ERROR_CODES.SESSION_NOT_FOUND });

  session.abortController.abort();
  session.status = 'cancelled';
  log.info(`ACP session ${sessionId}: cancelled`);
  return { sessionId, status: 'cancelled' };
}

// ── Method router ───────────────────────────────────────

const METHOD_HANDLERS: Record<string, (params?: Record<string, unknown>) => Promise<unknown>> = {
  initialize: handleInitialize,
  'session/new': handleSessionNew,
  'session/prompt': handleSessionPrompt,
  'session/cancel': handleSessionCancel,
};

async function dispatchMethod(
  method: string,
  params: Record<string, unknown> | undefined,
): Promise<unknown> {
  const handler = METHOD_HANDLERS[method];
  if (!handler) {
    throw Object.assign(new Error(`Method not found: ${method}`), { _acpCode: ACP_ERROR_CODES.METHOD_NOT_FOUND });
  }
  return handler(params);
}

// ── Route registration ──────────────────────────────────

export function registerAcpRoutes(app: FastifyInstance): void {
  /**
   * POST /acp — ACP JSON-RPC 2.0 endpoint.
   *
   * Accepts a single JSON-RPC request or an array for batching.
   * Returns JSON-RPC responses.
   */
  app.post('/acp', async (req, reply) => {
    try {
      const body = req.body as JsonRpcRequest | JsonRpcRequest[];

      // Batch support
      if (Array.isArray(body)) {
        const results: JsonRpcResponse[] = [];
        for (const item of body) {
          results.push(await processJsonRpcRequest(item));
        }
        reply.send(results);
        return;
      }

      const response = await processJsonRpcRequest(body);
      if (body && 'id' in body && body.id != null) {
        reply.send(response);
      } else {
        // Notification — no response
        reply.code(204).send();
      }
    } catch (err) {
      log.error('ACP unhandled error', { error: (err as Error).message });
      reply.code(500).send(jsonRpcError(req?.id ?? null, ACP_ERROR_CODES.INTERNAL_ERROR, 'Internal error'));
    }
  });

  log.info('ACP route registered: POST /acp');
}

async function processJsonRpcRequest(body: unknown): Promise<JsonRpcResponse> {
  const req = body as JsonRpcRequest;
  if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return jsonRpcError(null, ACP_ERROR_CODES.INVALID_REQUEST, 'Invalid JSON-RPC 2.0 request');
  }

  const id = req.id ?? null;

  try {
    const result = await dispatchMethod(req.method, req.params);
    return jsonRpcResult(id, result);
  } catch (err: unknown) {
    const error = err as Error & { _acpCode?: number };
    const code = error._acpCode ?? ACP_ERROR_CODES.INTERNAL_ERROR;
    return jsonRpcError(id, code, error.message);
  }
}
