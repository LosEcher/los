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
  _DEFAULT_NODE_LIST,
  _MAX_NODE_LIST,
  projectIntakeScope,
  projectNextAction,
  projectPlacedRun,
  projectNodeList,
  projectRecoveryResult,
  projectRunEvents,
  projectRunList,
  projectVerificationResult,
  readUntilEvent,
  runIdentity,
  stringArray,
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
/** `/chat` 接受的沙箱模式（`normalizeSandboxMode` 同口径）；与 allowedTools 一样需 operator。 */
const _SANDBOX_MODES = new Set(['readonly', 'workspace-write', 'sandbox']);

export function _createLosMCPAdapter(options: LosMCPAdapterOptions = {}): LosMCPAdapter {
  const gatewayUrl = (options.gatewayUrl ?? process.env.LOS_GATEWAY_URL ?? DEFAULT_GATEWAY).replace(/\/+$/, '');
  const authToken = options.authToken ?? process.env.LOS_AUTH_TOKEN;
  const operatorToken = options.operatorToken ?? process.env.LOS_OPERATOR_TOKEN;
  const tenantId = options.tenantId ?? process.env.LOS_MCP_TENANT_ID ?? 'local';
  const userId = options.userId ?? process.env.LOS_MCP_USER_ID ?? 'mcp-client';
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request(
    path: string,
    requestOptions: { method?: string; body?: JsonRecord; projectId: string; operator?: boolean; idempotencyKey?: string; signal?: AbortSignal },
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
    // 幂等键由调用方给（回退 dedupeKey）；没给才用随机键——随机键对重试无保护，
    // 所以"交接重试"必须显式给键，否则会重复建 run。
    if (requestOptions.idempotencyKey) headers.set('x-idempotency-key', requestOptions.idempotencyKey);
    if (requestOptions.body) headers.set('content-type', 'application/json');
    return await fetchImpl(`${gatewayUrl}${path}`, {
      method: requestOptions.method ?? 'GET',
      headers,
      body: requestOptions.body ? JSON.stringify(requestOptions.body) : undefined,
      signal: requestOptions.signal,
    });
  }

  async function requestJson(path: string, input: { projectId: string; method?: string; body?: JsonRecord; operator?: boolean; idempotencyKey?: string }): Promise<unknown> {
    const response = await request(path, input);
    const text = await response.text();
    if (!response.ok) throw new Error(redact(`LOS gateway ${response.status}: ${text.slice(0, _MAX_ERROR_TEXT)}`, authToken, operatorToken));
    return text ? JSON.parse(text) as unknown : {};
  }

  async function callTool(name: string, args: JsonRecord): Promise<unknown> {
    // 所有会改状态的工具共用同一口径：显式 idempotencyKey 优先，其次 los_run 的 dedupeKey。
    // 两者都缺 ⇒ 不发该头（由 request() 决定），调用方需自担重试重复风险。
    const idempotencyKey = optionalString(args.idempotencyKey) ?? optionalString(args.dedupeKey);
    if (name === 'los_run') {
      const prompt = requiredString(args.prompt, 'prompt');
      const projectId = requiredString(args.projectId, 'projectId');
      const toolMode = optionalString(args.toolMode) ?? 'read-only';
      const operatorScope = optionalBoolean(args.operatorScope, 'operatorScope') ?? false;
      const detach = optionalBoolean(args.detach, 'detach') ?? false;
      // 网关对 sandboxMode/allowedTools 走 requireOperator 闸门（chat-route 顶部），
      // 这里先本地拦：不带 operatorScope 直接拒，省一次注定 403 的往返。
      const sandboxMode = optionalString(args.sandboxMode);
      if (sandboxMode && !_SANDBOX_MODES.has(sandboxMode)) {
        throw new Error(`sandboxMode must be one of ${[..._SANDBOX_MODES].join(', ')}`);
      }
      if (args.allowedTools !== undefined && !Array.isArray(args.allowedTools)) {
        throw new Error('allowedTools must be an array of tool names');
      }
      const allowedTools = stringArray(args.allowedTools);
      if ((sandboxMode || allowedTools) && !operatorScope) {
        throw new Error('sandboxMode and allowedTools require operatorScope=true (the gateway gates them behind the operator credential)');
      }
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
        sandboxMode,
        allowedTools,
      });
      const controller = new AbortController();
      const response = await request('/chat', {
        method: 'POST', body, projectId, operator: operatorScope, idempotencyKey, signal: controller.signal,
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
      // blocked/error 终态只给"卡住了"是不够的：把 state 的 action/summary/blockers 一起带上，
      // 调用方才知道下一步该调哪个工具（例如 run_verification）。
      const status = detach && !terminal ? 'detached' : projection.status;
      let nextAction: JsonRecord | undefined;
      let nextActionError: string | undefined;
      if ((status === 'blocked' || status === 'error') && projection.runSpecId) {
        try {
          nextAction = projectNextAction(await requestJson(`/runs/${encodeURIComponent(String(projection.runSpecId))}/state`, { projectId }));
        } catch (error) {
          // 富化失败不能吞掉已经拿到的运行结果；如实带上原因
          nextActionError = (error instanceof Error ? error.message : String(error)).slice(0, _MAX_ERROR_TEXT);
        }
      }
      return compact({
        ...projection,
        status,
        detached: detach ? !terminal : undefined,
        ownerRepo: scope.ownerRepo,
        requestedProjectId: scope.requestedProjectId,
        workspaceRoot: scope.workspaceRoot,
        nextAction,
        nextActionError,
      });
    }

    if (name === 'los_runs_list') {
      const projectId = requiredString(args.projectId, 'projectId');
      const traceId = optionalString(args.traceId);
      const status = optionalString(args.status);
      const limit = optionalInteger(args.limit, 1, _MAX_RUN_LIST) ?? _DEFAULT_RUN_LIST;
      // 服务端过滤（projectId/status/limit）——避免"先取前 N 条再由客户端过滤"导致计数失真；
      // traceId 无服务端参数，仍由投影在客户端过滤。
      const query = new URLSearchParams();
      query.set('projectId', projectId);
      query.set('limit', String(limit));
      if (status) query.set('status', status);
      const rows = await requestJson(`/runs?${query}`, { projectId });
      return projectRunList(Array.isArray(rows) ? rows : [], { projectId, traceId, status, limit });
    }

    if (name === 'los_placed_run') {
      const projectId = requiredString(args.projectId, 'projectId');
      const goalTemplate = requiredString(args.goalTemplate, 'goalTemplate');
      const requiredCapabilities = stringArray(args.requiredCapabilities);
      if (args.requiredCapabilities !== undefined && !Array.isArray(args.requiredCapabilities)) {
        throw new Error('requiredCapabilities must be an array of capability names');
      }
      const nodeId = optionalString(args.nodeId);
      const created = await requestJson('/scheduled-work-items', {
        projectId,
        method: 'POST',
        operator: true,
        idempotencyKey,
        body: compact({
          title: optionalString(args.title) ?? `placed-run-${projectId}`,
          projectId,
          templateId: 'scheduled_execution',
          goalTemplate,
          toolMode: optionalString(args.toolMode) ?? 'read-only',
          sandboxMode: optionalString(args.sandboxMode),
          workspaceRoot: optionalString(args.workspaceRoot),
          editableSurfaces: stringArray(args.editableSurfaces),
          requiredChecks: stringArray(args.requiredChecks),
          maxLoops: optionalInteger(args.maxLoops, 1, 200),
          approvalPolicy: 'preapproved_scope',
          executor: compact({ enabled: true, nodeId, requiredCapabilities }),
          trigger: { kind: 'once', timezone: 'Asia/Shanghai', expression: '2099-01-01T00:00:00.000Z' },
        }),
      });
      const scheduleId = optionalString(optionalRecord(optionalRecord(created)?.schedule)?.id)
        ?? optionalString(optionalRecord(created)?.id);
      if (!scheduleId) throw new Error('scheduled work item was created without an id');
      if (args.trigger === false) return projectPlacedRun(created, undefined);
      const triggered = await requestJson(`/scheduled-work-items/${scheduleId}/trigger`, {
        projectId,
        method: 'POST',
        operator: true,
        idempotencyKey,
        body: {},
      });
      return projectPlacedRun(created, triggered);
    }

    if (name === 'los_nodes_list') {
      const projectId = requiredString(args.projectId, 'projectId');
      const status = optionalString(args.status);
      const limit = optionalInteger(args.limit, 1, _MAX_NODE_LIST) ?? _DEFAULT_NODE_LIST;
      // /nodes 是 operator 门禁（node-routes.ts:93）⇒ 与 verify/approve 同款：无凭据先抛错。
      const rows = await requestJson('/nodes', { projectId, operator: true });
      return projectNodeList(Array.isArray(rows) ? rows : [], { status, limit });
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
        idempotencyKey,
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
        idempotencyKey,
        body: compact({ reason: optionalString(args.reason), planRevision, contractHash }),
      });
    }

    if (name === 'los_run_recover') {
      const runSpecId = requiredString(args.runSpecId, 'runSpecId');
      const projectId = requiredString(args.projectId, 'projectId');
      const apply = optionalBoolean(args.apply, 'apply') ?? false;
      const intent = optionalString(args.intent);
      if (intent && intent !== 'recover' && intent !== 'cancel') throw new Error('intent must be recover or cancel');
      const result = await requestJson(`/runs/${encodeURIComponent(runSpecId)}/recover`, {
        projectId,
        method: 'POST',
        operator: true,
        idempotencyKey,
        // apply 缺省不发 ⇒ 网关走只读预览分支（不做任何状态迁移）
        body: compact({
          apply: apply ? true : undefined,
          intent,
          staleMs: optionalInteger(args.staleMs, 0, Number.MAX_SAFE_INTEGER),
          reason: optionalString(args.reason),
        }),
      });
      return projectRecoveryResult(result, apply);
    }

    if (name === 'los_run_revise_plan') {
      const runSpecId = requiredString(args.runSpecId, 'runSpecId');
      const projectId = requiredString(args.projectId, 'projectId');
      const plan = Array.isArray(args.plan) ? args.plan : undefined;
      // 网关允许 plan 缺省（只递增 revision），但那对调用方几乎总是笔误 ⇒ 本地先拒
      if (!plan || plan.length === 0) throw new Error('plan must be a non-empty array of plan steps');
      return await requestJson(`/runs/${encodeURIComponent(runSpecId)}/revise-plan`, {
        projectId,
        method: 'POST',
        operator: true,
        idempotencyKey,
        body: compact({ plan, reason: optionalString(args.reason) }),
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
        idempotencyKey,
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
        method: 'POST', body, projectId, operator: true, idempotencyKey,
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
