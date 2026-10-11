/**
 * MCP 适配器的**投影与事件读取**——SSE 解析、归属判定、fail-loud、列表/终端投影。
 *
 * 为什么单独成文件：`mcp-serve.ts` 逼近 `tools/check-structure.sh` 的 500 行门禁
 *（拆 `mcp-tools.ts` 后仍有 13 行余量），而这一整块是纯函数、与传输层无关。
 *
 * 关于 `_` 前缀：本仓 wiring 扫描器（`tools/check-wiring-topology.ts`）只把
 * **调用语法**当 caller，导出的 const 永远被判 orphan ⇒ 内部常量一律 `_` 前缀
 *（与 `mcp-tools.ts` 同一约定）；导出的函数正常命名，因为它们会被调用。
 */

export type JsonRecord = Record<string, unknown>;

/** 分派/投影共用的 SSE 事件形状。 */
export type SseEvent = { event: string; data: JsonRecord };

export const _MAX_ERROR_TEXT = 500;
export const _MAX_RESULT_TEXT = 20_000;
export const _MAX_PROMPT_PREVIEW = 120;
/** 终态事件：出现即表示这次运行已经收口（无需继续持连接）。 */
export const _TERMINAL_EVENTS = new Set(['done', 'blocked', 'cancelled', 'error']);

export function parseSSE(raw: string): Array<{ event: string; data: JsonRecord }> {
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
      events.push({ event, data: { raw: dataLines.join('\n').slice(0, _MAX_ERROR_TEXT) } });
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
export async function readUntilEvent(
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
export function runIdentity(events: Array<{ event: string; data: JsonRecord }>): { sessionId?: string; runSpecId?: string; taskRunId?: string } {
  const terminal = [...events].reverse().find(item => _TERMINAL_EVENTS.has(item.event))?.data ?? {};
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

export function projectRunEvents(events: Array<{ event: string; data: JsonRecord }>): JsonRecord {
  const terminal = [...events].reverse().find(item => _TERMINAL_EVENTS.has(item.event));
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
    text: optionalString(data.text)?.slice(0, _MAX_RESULT_TEXT),
    message: optionalString(data.message)?.slice(0, _MAX_ERROR_TEXT),
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
export function projectRunList(rows: unknown[], filter: RunListFilter): JsonRecord {
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
    promptPreview: optionalString(row.prompt)?.slice(0, _MAX_PROMPT_PREVIEW),
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
export function projectIntakeScope(events: Array<{ event: string; data: JsonRecord }>): IntakeScope {
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
export function assertResolvedProjectScope(input: {
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

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function optionalRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined;
}


export function compact(value: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

/** 单条验证记录的输出上限：`outputSummary` 可能很长（整段构建输出），列表里不能全带。 */
export const _MAX_VERIFICATION_OUTPUT = 300;

/**
 * `los_run_verify` 的有界投影：决策 + 跑了哪些记录 + 每条记录的裁剪摘要。
 *
 * 网关原始返回带完整 `VerificationRecord[]`（含 `outputSummary` 全量），
 * 一个多检查的 run 足以把结果撑爆，所以这里必须裁剪。
 */
export function projectVerificationResult(result: unknown): JsonRecord {
  const value = optionalRecord(result) ?? {};
  const decision = optionalRecord(value.decision) ?? {};
  const records = Array.isArray(value.records) ? value.records : [];
  const recovery = optionalRecord(value.recovery);
  return compact({
    runSpecId: optionalString(value.runSpecId),
    decision: compact({
      status: optionalString(decision.status),
      blockedVerificationRecordIds: stringArray(decision.blockedVerificationRecordIds),
      failedVerificationRecordIds: stringArray(decision.failedVerificationRecordIds),
      pendingVerificationRecordIds: stringArray(decision.pendingVerificationRecordIds),
    }),
    ranRecordIds: stringArray(value.ranRecordIds),
    records: records.map(row => {
      const record = optionalRecord(row) ?? {};
      return compact({
        id: optionalString(record.id),
        checkName: optionalString(record.checkName),
        kind: optionalString(record.kind),
        status: optionalString(record.status),
        required: typeof record.required === 'boolean' ? record.required : undefined,
        outputSummary: optionalString(record.outputSummary)?.slice(0, _MAX_VERIFICATION_OUTPUT),
      });
    }),
    recovery: recovery
      ? compact({
        runSpecId: optionalString(recovery.runSpecId),
        exhausted: typeof recovery.exhausted === 'boolean' ? recovery.exhausted : undefined,
      })
      : undefined,
  });
}

/** 字符串数组参数的安全投影：非数组或含非字符串项时只保留字符串项。 */
export function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

/** id 列表上限：blocked/error 结果里回传的 id 列表只用于定位，不需要全量。 */
export const _MAX_ID_LIST = 20;
export const _MAX_REASONS = 10;
export const _MAX_BLOCKER_TEXT = 200;

/** 截断 id 列表并如实报告是否截断（不静默丢信息）。 */
export function capIds(value: unknown, limit = _MAX_ID_LIST): { ids: string[]; truncated: boolean } | undefined {
  const ids = stringArray(value);
  if (!ids) return undefined;
  return { ids: ids.slice(0, limit), truncated: ids.length > limit };
}

/**
 * `los_run_state` 返回里的"下一步"部分——`los_run` 在 blocked/error 终态时附带回传。
 *
 * 为什么需要：终态只给 `blockedVerificationRecordIds` 时，调用方知道"卡住了"却不知道
 * **下一步该调哪个工具**；`action`（如 `run_verification`）才是可执行的指令。
 */
export function projectNextAction(state: unknown): JsonRecord {
  const value = optionalRecord(state) ?? {};
  const blockers = Array.isArray(value.blockers) ? value.blockers : [];
  return compact({
    phase: optionalString(value.phase),
    action: optionalString(value.action),
    summary: optionalString(value.summary),
    blockers: blockers.map(row => {
      const blocker = optionalRecord(row) ?? {};
      return compact({
        kind: optionalString(blocker.kind),
        message: optionalString(blocker.message)?.slice(0, _MAX_BLOCKER_TEXT),
        ids: capIds(blocker.ids),
      });
    }),
    reasons: stringArray(optionalRecord(value.recovery)?.reasons)?.slice(0, _MAX_REASONS),
  });
}

