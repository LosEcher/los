import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

import { _DEFAULT_RUN_LIST, _MAX_RUN_LIST, _TOOLS } from './mcp-tools.js';
import {
  _MAX_ERROR_TEXT,
  _MAX_RESULT_TEXT,
  _TERMINAL_EVENTS,
  assertResolvedProjectScope,
  compact,
  optionalRecord,
  optionalString,
  parseSSE,
  projectIntakeScope,
  projectRunEvents,
  projectRunList,
  projectVerificationResult,
  readUntilEvent,
  runIdentity,
  type JsonRecord,
} from './mcp-projections.js';

type RequestId = string | number;

interface JSONRPCRequest {
  jsonrpc: '2.0';
  id?: RequestId;
  method?: string;
  params?: JsonRecord;
}

interface JSONRPCResponse {
  jsonrpc: '2.0';
  id: RequestId;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface LosMCPAdapterOptions {
  gatewayUrl?: string;
  authToken?: string;
  operatorToken?: string;
  tenantId?: string;
  userId?: string;
  fetchImpl?: typeof fetch;
}

export interface LosMCPAdapter {
  handle(message: JSONRPCRequest): Promise<JSONRPCResponse | null>;
}

const PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_GATEWAY = 'http://127.0.0.1:8080';

export function _createLosMCPAdapter(options: LosMCPAdapterOptions = {}): LosMCPAdapter {
  const gatewayUrl = (options.gatewayUrl ?? process.env.LOS_GATEWAY_URL ?? DEFAULT_GATEWAY).replace(/\/+$/, '');
  const authToken = options.authToken ?? process.env.LOS_AUTH_TOKEN;
  const operatorToken = options.operatorToken ?? process.env.LOS_OPERATOR_TOKEN;
  const tenantId = options.tenantId ?? process.env.LOS_MCP_TENANT_ID ?? 'local';
  const userId = options.userId ?? process.env.LOS_MCP_USER_ID ?? 'mcp-client';
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request(
    path: string,
    requestOptions: { method?: string; body?: JsonRecord; projectId: string; operator?: boolean; idempotent?: boolean; signal?: AbortSignal },
  ): Promise<Response> {
    if (requestOptions.operator && !operatorToken) {
      throw new Error('LOS_OPERATOR_TOKEN is required for operator-controlled MCP tools');
    }
    const headers = new Headers({
      'x-tenant-id': tenantId,
      'x-project-id': requestOptions.projectId,
      'x-user-id': userId,
    });
    if (authToken) headers.set('x-los-auth-token', authToken);
    if (requestOptions.operator && operatorToken) headers.set('x-los-operator-token', operatorToken);
    if (requestOptions.idempotent) headers.set('x-idempotency-key', `mcp-${randomUUID()}`);
    if (requestOptions.body) headers.set('content-type', 'application/json');
    return await fetchImpl(`${gatewayUrl}${path}`, {
      method: requestOptions.method ?? 'GET',
      headers,
      body: requestOptions.body ? JSON.stringify(requestOptions.body) : undefined,
      signal: requestOptions.signal,
    });
  }

  async function requestJson(path: string, input: { projectId: string; method?: string; body?: JsonRecord; operator?: boolean; idempotent?: boolean }): Promise<unknown> {
    const response = await request(path, input);
    const text = await response.text();
    if (!response.ok) throw new Error(redact(`LOS gateway ${response.status}: ${text.slice(0, _MAX_ERROR_TEXT)}`, authToken, operatorToken));
    return text ? JSON.parse(text) as unknown : {};
  }

  async function callTool(name: string, args: JsonRecord): Promise<unknown> {
    if (name === 'los_run') {
      const prompt = requiredString(args.prompt, 'prompt');
      const projectId = requiredString(args.projectId, 'projectId');
      const toolMode = optionalString(args.toolMode) ?? 'read-only';
      const operatorScope = optionalBoolean(args.operatorScope, 'operatorScope') ?? false;
      const detach = optionalBoolean(args.detach, 'detach') ?? false;
      if (toolMode !== 'read-only' && toolMode !== 'project-write') throw new Error('toolMode must be read-only or project-write');
      if (toolMode === 'project-write' && !operatorToken) throw new Error('LOS_OPERATOR_TOKEN is required for project-write MCP runs');
      if (operatorScope && !operatorToken) throw new Error('LOS_OPERATOR_TOKEN is required for operator-scoped MCP runs');
      const body = compact({
        prompt,
        projectId,
        workspaceRoot: optionalString(args.workspaceRoot),
        sessionId: optionalString(args.sessionId),
        provider: optionalString(args.provider),
        model: optionalString(args.model),
        toolMode,
        maxLoops: optionalInteger(args.maxLoops, 1, 100),
        traceId: optionalString(args.traceId),
        dedupeKey: optionalString(args.dedupeKey),
        runContract: optionalRecord(args.runContract),
      });
      const controller = new AbortController();
      const response = await request('/chat', {
        method: 'POST', body, projectId, operator: operatorScope, idempotent: true, signal: controller.signal,
      });
      if (!response.ok) {
        const raw = await response.text();
        throw new Error(redact(`LOS gateway ${response.status}: ${raw.slice(0, _MAX_ERROR_TEXT)}`, authToken, operatorToken));
      }
      const events = detach
        ? await readUntilEvent(response, controller, seen => {
          if (seen.some(item => _TERMINAL_EVENTS.has(item.event))) return true;
          const ids = runIdentity(seen);
          return Boolean(ids.sessionId && ids.runSpecId && ids.taskRunId);
        })
        : parseSSE(await response.text());
      const scope = projectIntakeScope(events);
      const projection = projectRunEvents(events);
      assertResolvedProjectScope({ requestedProjectId: projectId, operatorScope, scope, projection });
      const terminal = events.some(item => _TERMINAL_EVENTS.has(item.event));
      return compact({
        ...projection,
        status: detach && !terminal ? 'detached' : projection.status,
        detached: detach ? !terminal : undefined,
        ownerRepo: scope.ownerRepo,
        requestedProjectId: scope.requestedProjectId,
        workspaceRoot: scope.workspaceRoot,
      });
    }

    if (name === 'los_runs_list') {
      const projectId = requiredString(args.projectId, 'projectId');
      const traceId = optionalString(args.traceId);
      const status = optionalString(args.status);
      const limit = optionalInteger(args.limit, 1, _MAX_RUN_LIST) ?? _DEFAULT_RUN_LIST;
      const rows = await requestJson('/runs', { projectId });
      return projectRunList(Array.isArray(rows) ? rows : [], { projectId, traceId, status, limit });
    }

    if (name === 'los_run_state') {
      const runSpecId = requiredString(args.runSpecId, 'runSpecId');
      const projectId = requiredString(args.projectId, 'projectId');
      return await requestJson(`/runs/${encodeURIComponent(runSpecId)}/state`, { projectId });
    }

    if (name === 'los_run_replay') {
      const runSpecId = requiredString(args.runSpecId, 'runSpecId');
      const projectId = requiredString(args.projectId, 'projectId');
      const query = new URLSearchParams({
        since: String(optionalInteger(args.since, 0, Number.MAX_SAFE_INTEGER) ?? 0),
        streamSince: String(optionalInteger(args.streamSince, 0, Number.MAX_SAFE_INTEGER) ?? 0),
        limit: String(optionalInteger(args.limit, 1, 500) ?? 100),
      });
      return await requestJson(`/runs/${encodeURIComponent(runSpecId)}/stream?${query}`, { projectId });
    }

    if (name === 'los_run_verify') {
      const runSpecId = requiredString(args.runSpecId, 'runSpecId');
      const projectId = requiredString(args.projectId, 'projectId');
      // 网关该路由 requireOperator ⇒ operator: true（无凭据时 request() 会先抛错，不发 HTTP）
      const result = await requestJson(`/runs/${encodeURIComponent(runSpecId)}/verify`, {
        projectId,
        method: 'POST',
        operator: true,
        idempotent: true,
        body: compact({
          cwd: optionalString(args.cwd),
          timeoutMs: optionalInteger(args.timeoutMs, 0, Number.MAX_SAFE_INTEGER),
          outputLimit: optionalInteger(args.outputLimit, 0, Number.MAX_SAFE_INTEGER),
          includeFailed: typeof args.includeFailed === 'boolean' ? args.includeFailed : undefined,
        }),
      });
      return projectVerificationResult(result);
    }

    if (name === 'los_run_approve') {
      const runSpecId = requiredString(args.runSpecId, 'runSpecId');
      const projectId = requiredString(args.projectId, 'projectId');
      const planRevision = optionalInteger(args.planRevision, 1, Number.MAX_SAFE_INTEGER);
      const contractHash = optionalString(args.contractHash);
      // 网关口径：两者必须成对出现（只给一个会被 409 拒）；这里先本地拒绝，省一次往返
      if ((planRevision === undefined) !== (contractHash === undefined)) {
        throw new Error('planRevision and contractHash must be provided together');
      }
      return await requestJson(`/runs/${encodeURIComponent(runSpecId)}/approve`, {
        projectId,
        method: 'POST',
        operator: true,
        idempotent: true,
        body: compact({ reason: optionalString(args.reason), planRevision, contractHash }),
      });
    }

    if (name === 'los_task_cancel') {
      const taskRunId = requiredString(args.taskRunId, 'taskRunId');
      const projectId = requiredString(args.projectId, 'projectId');
      // 网关该路由**没有** operator 门禁（在 route-admission 的 review 列表里）⇒ 适配器比网关更严：
      // operator: true 让无凭据时先抛错、不发 HTTP。
      return await requestJson(`/tasks/${encodeURIComponent(taskRunId)}/cancel`, {
        projectId,
        method: 'POST',
        operator: true,
        idempotent: true,
        body: compact({ reason: optionalString(args.reason) }),
      });
    }

    if (name === 'los_operator_control') {
      const sessionId = requiredString(args.sessionId, 'sessionId');
      const projectId = requiredString(args.projectId, 'projectId');
      const type = requiredString(args.type, 'type');
      if (type !== 'steering' && type !== 'followup') throw new Error('type must be steering or followup');
      const body = compact({
        type,
        instruction: type === 'steering' ? requiredString(args.instruction, 'instruction') : undefined,
        prompt: type === 'followup' ? requiredString(args.prompt, 'prompt') : undefined,
        runSpecId: optionalString(args.runSpecId),
        taskRunId: optionalString(args.taskRunId),
        reason: optionalString(args.reason),
        turnBoundary: optionalString(args.turnBoundary),
        drainMode: optionalString(args.drainMode),
      });
      return await requestJson(`/sessions/${encodeURIComponent(sessionId)}/operator-events`, {
        method: 'POST', body, projectId, operator: true, idempotent: true,
      });
    }

    throw new Error(`Unknown MCP tool: ${name}`);
  }

  return {
    async handle(message) {
      if (message.method === 'notifications/initialized' || message.id === undefined) return null;
      if (message.method === 'initialize') {
        return rpcResult(message.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'los-programmatic-interface', version: '0.1.0' },
        });
      }
      if (message.method === 'tools/list') return rpcResult(message.id, { tools: _TOOLS });
      if (message.method !== 'tools/call') return rpcError(message.id, -32601, `Method not found: ${message.method ?? '<missing>'}`);

      const name = optionalString(message.params?.name);
      const args = optionalRecord(message.params?.arguments) ?? {};
      if (!name) return rpcError(message.id, -32602, 'tools/call requires params.name');
      try {
        const value = await callTool(name, args);
        return rpcResult(message.id, { content: [{ type: 'text', text: JSON.stringify(value) }] });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        return rpcResult(message.id, { content: [{ type: 'text', text: messageText.slice(0, _MAX_RESULT_TEXT) }], isError: true });
      }
    },
  };
}

export async function mcpServeCommand(globalArgs: string[], argv: string[]): Promise<void> {
  if (argv[0] !== 'serve') throw new Error('Usage: los mcp serve [--gateway URL]');
  const flags = parseFlags([...globalArgs, ...argv.slice(1)]);
  const adapter = _createLosMCPAdapter({
    gatewayUrl: flags.gateway,
    authToken: flags['auth-token'],
    operatorToken: flags['operator-token'],
    tenantId: flags['tenant-id'],
    userId: flags['user-id'],
  });
  process.stderr.write(`los MCP adapter ready (gateway: ${flags.gateway ?? process.env.LOS_GATEWAY_URL ?? DEFAULT_GATEWAY})\n`);
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let response: JSONRPCResponse | null;
    try {
      const message = JSON.parse(line) as JSONRPCRequest;
      response = message.jsonrpc === '2.0' ? await adapter.handle(message) : null;
    } catch {
      response = rpcError(0, -32700, 'Parse error');
    }
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}


function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith('--')) continue;
    const [key, inline] = token.slice(2).split('=', 2);
    const value = inline ?? argv[i + 1];
    if (value && !value.startsWith('--')) {
      flags[key] = value;
      if (inline === undefined) i += 1;
    }
  }
  return flags;
}

function requiredString(value: unknown, name: string): string {
  const result = optionalString(value);
  if (!result) throw new Error(`${name} is required`);
  return result;
}

function optionalInteger(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`Expected integer between ${min} and ${max}`);
  return number;
}

/** 布尔参数：接受真布尔与 `'true'`/`'false'`（模型常发字符串），其余值显式报错而非静默取假。 */
function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be a boolean`);
}

function redact(value: string, ...secrets: Array<string | undefined>): string {
  let result = value;
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join('[REDACTED]');
  }
  return result;
}

function rpcResult(id: RequestId, result: unknown): JSONRPCResponse {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: RequestId, code: number, message: string): JSONRPCResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
