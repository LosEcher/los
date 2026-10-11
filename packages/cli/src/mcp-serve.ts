import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

import { _DEFAULT_RUN_LIST, _MAX_RUN_LIST, _TOOLS } from './mcp-tools.js';

type JsonRecord = Record<string, unknown>;
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
const MAX_ERROR_TEXT = 500;
const MAX_RESULT_TEXT = 20_000;
const MAX_PROMPT_PREVIEW = 120;
/** 终态事件：出现即表示这次运行已经收口（无需继续持连接）。 */
const TERMINAL_EVENTS = new Set(['done', 'blocked', 'cancelled', 'error']);

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
    if (!response.ok) throw new Error(redact(`LOS gateway ${response.status}: ${text.slice(0, MAX_ERROR_TEXT)}`, authToken, operatorToken));
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
        throw new Error(redact(`LOS gateway ${response.status}: ${raw.slice(0, MAX_ERROR_TEXT)}`, authToken, operatorToken));
      }
      const events = detach
        ? await readUntilEvent(response, controller, seen => {
          if (seen.some(item => TERMINAL_EVENTS.has(item.event))) return true;
          const ids = runIdentity(seen);
          return Boolean(ids.sessionId && ids.runSpecId && ids.taskRunId);
        })
        : parseSSE(await response.text());
      const scope = projectIntakeScope(events);
      const projection = projectRunEvents(events);
      assertResolvedProjectScope({ requestedProjectId: projectId, operatorScope, scope, projection });
      const terminal = events.some(item => TERMINAL_EVENTS.has(item.event));
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
        return rpcResult(message.id, { content: [{ type: 'text', text: messageText.slice(0, MAX_RESULT_TEXT) }], isError: true });
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

function parseSSE(raw: string): Array<{ event: string; data: JsonRecord }> {
  const events: Array<{ event: string; data: JsonRecord }> = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) continue;
    try {
      const value = JSON.parse(dataLines.join('\n')) as unknown;
      events.push({ event, data: optionalRecord(value) ?? {} });
    } catch {
      events.push({ event, data: { raw: dataLines.join('\n').slice(0, MAX_ERROR_TEXT) } });
    }
  }
  return events;
}

/**
 * 流式读 SSE，直到 `stopWhen` 命中（或流结束），随后**主动断开**连接。
 *
 * 这是 `los_run(detach)` 的机制：宿主可以在工具超时前拿到 id 就撤，不必等整条流。
 * 安全性有实测依据（2026-10-11）：读到 `session` 事件后 abort，运行照常
 * `run_specs.status=succeeded` / `task_runs.status=succeeded` —— **执行不依赖 SSE 消费者**。
 * 证据与探针见 `docs/operations/2026-10-11-dsh-los-cross-project-dispatch-audit.md` §9.2。
 */
async function readUntilEvent(
  response: Response,
  controller: AbortController,
  stopWhen: (events: Array<{ event: string; data: JsonRecord }>) => boolean,
): Promise<Array<{ event: string; data: JsonRecord }>> {
  const reader = response.body?.getReader();
  if (!reader) return parseSSE(await response.text());
  const decoder = new TextDecoder();
  let raw = '';
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      break; // abort 之后读取会抛；此时已有足够事件
    }
    if (chunk.done) break;
    raw += decoder.decode(chunk.value, { stream: true });
    if (stopWhen(parseSSE(raw))) break;
  }
  controller.abort();
  return parseSSE(raw);
}

/**
 * 分派身份（三个 id）——**这是 detach 与投影的唯一取 id 口径**。
 *
 * 为什么必须跨事件取（2026-10-11 实测形状）：
 *   · `runSpecId` 只在 `coordinator.intake_resolved` 的 `payload.runSpecId` 里，早于终态出现；
 *   · `session` 事件只有 `{sessionId, taskRunId, …}`，**没有 runSpecId**；
 *   · 终态 `done` 事件是扁平的，三个 id 齐全。
 * 先前的实现只读终态 + `session`，于是 detach（停在 `session`）拿不到 runSpecId —— 探针首跑即暴露。
 */
function runIdentity(events: Array<{ event: string; data: JsonRecord }>): { sessionId?: string; runSpecId?: string; taskRunId?: string } {
  const terminal = [...events].reverse().find(item => TERMINAL_EVENTS.has(item.event))?.data ?? {};
  const session = events.find(item => item.event === 'session')?.data ?? {};
  const task = events.find(item => item.event === 'task')?.data ?? {};
  const intake = events.find(item => item.event === 'coordinator.intake_resolved')?.data ?? {};
  const intakePayload = optionalRecord(intake.payload) ?? {};
  return {
    sessionId: optionalString(terminal.sessionId) ?? optionalString(session.sessionId) ?? optionalString(intake.sessionId),
    runSpecId: optionalString(terminal.runSpecId) ?? optionalString(intakePayload.runSpecId) ?? optionalString(intake.runSpecId),
    taskRunId: optionalString(terminal.taskRunId) ?? optionalString(session.taskRunId) ?? optionalString(task.taskRunId),
  };
}

function projectRunEvents(events: Array<{ event: string; data: JsonRecord }>): JsonRecord {
  const terminal = [...events].reverse().find(item => TERMINAL_EVENTS.has(item.event));
  const data = terminal?.data ?? {};
  const identity = runIdentity(events);
  return compact({
    status: terminal?.event ?? 'unknown',
    sessionId: identity.sessionId,
    runSpecId: identity.runSpecId,
    taskRunId: identity.taskRunId,
    traceId: optionalString(data.traceId),
    requestId: optionalString(data.requestId),
    runSpecStatus: optionalString(data.runSpecStatus),
    text: optionalString(data.text)?.slice(0, MAX_RESULT_TEXT),
    message: optionalString(data.message)?.slice(0, MAX_ERROR_TEXT),
    blockedVerificationRecordIds: Array.isArray(data.blockedVerificationRecordIds) ? data.blockedVerificationRecordIds : undefined,
    eventTypes: [...new Set(events.map(item => item.event))],
  });
}

interface RunListFilter {
  projectId: string;
  traceId?: string;
  status?: string;
  limit: number;
}

/**
 * `los_runs_list` 的投影：过滤 → 按 `createdAt` 倒序 → 取前 `limit` 条 → 逐条裁剪。
 *
 * 为什么在适配器侧做：`GET /runs` 的 handler 不收任何过滤参数、直接返回 store 的默认上限
 * （实测 50 行，`file:packages/gateway/src/routes/orchestration/run-routes.ts:95`），
 * 且每行带**完整 prompt**——不裁剪就会把大段提示词灌进 MCP 结果。
 */
function projectRunList(rows: unknown[], filter: RunListFilter): JsonRecord {
  const matched = rows
    .map(row => optionalRecord(row) ?? {})
    .filter(row => optionalString(row.projectId) === filter.projectId)
    .filter(row => !filter.traceId || optionalString(row.traceId) === filter.traceId)
    .filter(row => !filter.status || optionalString(row.status) === filter.status)
    .sort((left, right) => String(optionalString(right.createdAt) ?? '')
      .localeCompare(String(optionalString(left.createdAt) ?? '')));
  const items = matched.slice(0, filter.limit).map(row => compact({
    runSpecId: optionalString(row.id),
    sessionId: optionalString(row.sessionId),
    projectId: optionalString(row.projectId),
    status: optionalString(row.status),
    toolMode: optionalString(row.toolMode),
    traceId: optionalString(row.traceId),
    createdAt: optionalString(row.createdAt),
    updatedAt: optionalString(row.updatedAt),
    promptPreview: optionalString(row.prompt)?.slice(0, MAX_PROMPT_PREVIEW),
  }));
  return { matched: matched.length, returned: items.length, items };
}

interface IntakeScope {
  ownerRepo?: string;
  requestedProjectId?: string;
  workspaceRoot?: string;
  reason?: string;
  blocker?: string;
}

/**
 * 读取网关的**项目归属判定**（首个 `coordinator.intake_resolved` 事件）。
 *
 * 为什么必须有这一步：`auth.enabled` 时，网关对**非 operator** 调用方固定使用配置的默认项目，
 * 调用方给的 `projectId` 只当路由提示被丢弃（`packages/gateway/src/request-context.ts` 的
 * `onRequest` 与 `resolveProjectScope`）。没有这道读取，`los_run(projectId=X)` 会**静默**
 * 跑在默认项目上，返回的却是"成功"。
 *
 * 形状（2026-10-11 实测 `/tmp/sse-dump.txt`）：会话事件流以**信封**下发，
 * 归属字段在 `data.payload` 里（`data.payload.ownerRepo`），信封自身另有网关标注的
 * `data.projectId`；两种都读，避免信封形态变化就静默失效。
 */
function projectIntakeScope(events: Array<{ event: string; data: JsonRecord }>): IntakeScope {
  const intake = events.find(item => item.event === 'coordinator.intake_resolved');
  const data = intake?.data ?? {};
  const payload = optionalRecord(data.payload) ?? {};
  return {
    ownerRepo: optionalString(payload.ownerRepo) ?? optionalString(data.ownerRepo) ?? optionalString(data.projectId),
    requestedProjectId: optionalString(payload.requestedProjectId) ?? optionalString(data.requestedProjectId),
    workspaceRoot: optionalString(payload.workspaceRoot) ?? optionalString(data.workspaceRoot),
    reason: optionalString(payload.reason) ?? optionalString(data.reason),
    blocker: optionalString(payload.blocker) ?? optionalString(data.blocker),
  };
}

/**
 * fail-loud：网关解析出的项目 ≠ 请求的项目 ⇒ 抛错，并**把 id 带在错误里**。
 *
 * 为什么不直接丢弃结果：调用方拿不到 `runSpecId` 就无法复盘/接管这次运行
 * （blocked 终态本来就可能不带 runSpecId）。只在网关确实给了 `ownerRepo` 时判定，
 * 避免把"没读到"误判成"不一致"。
 */
function assertResolvedProjectScope(input: {
  requestedProjectId: string;
  operatorScope: boolean;
  scope: IntakeScope;
  projection: JsonRecord;
}): void {
  const { requestedProjectId, operatorScope, scope, projection } = input;
  if (!scope.ownerRepo || scope.ownerRepo === requestedProjectId) return;
  const guidance = operatorScope
    ? `the operator-scoped call was still resolved elsewhere; bind '${requestedProjectId}' in the gateway project registry or pass a workspaceRoot inside it`
    : `a non-operator call is pinned to the gateway default project; pass operatorScope=true (requires the adapter operator credential) to target '${requestedProjectId}'`;
  throw new Error([
    `project scope mismatch: requested projectId='${requestedProjectId}' but the gateway resolved ownerRepo='${scope.ownerRepo}'`,
    `(reason=${scope.reason ?? 'unknown'}, blocker=${scope.blocker ?? 'none'}).`,
    `${guidance}.`,
    `runSpecId=${optionalString(projection.runSpecId) ?? 'none'} sessionId=${optionalString(projection.sessionId) ?? 'none'}`,
  ].join(' '));
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

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function optionalInteger(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`Expected integer between ${min} and ${max}`);
  return number;
}

function compact(value: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
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
