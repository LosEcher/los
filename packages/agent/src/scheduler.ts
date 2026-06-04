/**
 * @los/agent/scheduler — Single-process task scheduler wrapper.
 *
 * This is intentionally small: it owns task lifecycle evidence and dedupe,
 * while runAgent still owns model/tool execution.
 */

import { randomUUID } from 'node:crypto';
import { appendSessionEvent, ensureSessionEventStore } from './session-events.js';
import { listExecutorNodes, type ExecutorNodeRecord } from './executor-nodes.js';
import { runAgent, type AgentConfig, type AgentResult, type TurnSummary } from './loop.js';
import {
  createTaskRun,
  ensureTaskRunStore,
  findActiveTaskRunByDedupeKey,
  heartbeatTaskRun,
  loadTaskRun,
  updateTaskRun,
  type TaskRunRecord,
} from './task-runs.js';

export type ScheduledTaskEventType =
  | 'task.created'
  | 'task.deduplicated'
  | 'task.running'
  | 'task.cancelled'
  | 'task.succeeded'
  | 'task.failed';

export interface ScheduledTaskEvent {
  type: ScheduledTaskEventType;
  taskRun: TaskRunRecord;
}

export interface ScheduledAgentTaskInput extends AgentConfig {
  prompt: string;
  taskRunId?: string;
  runSpecId?: string;
  traceId?: string;
  dedupeKey?: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  requestId?: string;
  timeoutMs?: number;
  promptPreview?: string;
  metadata?: Record<string, unknown>;
  executor?: ScheduledExecutorConfig;
  onTaskEvent?: (event: ScheduledTaskEvent) => void | Promise<void>;
}

export interface ScheduledExecutorConfig {
  enabled?: boolean;
  nodeUrls?: readonly string[];
  agentKey?: string;
  nodeId?: string;
  leaseMs?: number;
  heartbeatMs?: number;
}

export type ScheduledAgentTaskResult =
  | {
      status: 'completed';
      sessionId: string;
      taskRun: TaskRunRecord;
      result: AgentResult;
    }
  | {
      status: 'deduplicated';
      sessionId: string;
      taskRun: TaskRunRecord;
    }
  | {
      status: 'cancelled';
      sessionId: string;
      taskRun: TaskRunRecord;
      reason: string;
    };

type RunningTaskController = {
  controller: AbortController;
  reason: string;
};

const runningTaskControllers = new Map<string, RunningTaskController>();

export async function runScheduledAgentTask(input: ScheduledAgentTaskInput): Promise<ScheduledAgentTaskResult> {
  await ensureTaskRunStore();
  await ensureSessionEventStore();

  const taskRunId = input.taskRunId ?? `task-${randomUUID()}`;
  const sessionId = input.sessionId ?? `session-${Date.now()}`;
  const traceId = input.traceId ?? taskRunId;
  const dedupeKey = normalizeOptionalString(input.dedupeKey);
  const toolMode = input.toolMode ?? 'project-write';
  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  const timeoutMs = normalizePositiveInteger(input.timeoutMs);
  const executor = await resolveExecutor(input.executor);
  const nodeId = executor?.nodeId ?? 'gateway-local';
  const leaseMs = normalizePositiveInteger(input.executor?.leaseMs) ?? 30_000;
  const heartbeatMs = normalizePositiveInteger(input.executor?.heartbeatMs) ?? Math.max(1_000, Math.floor(leaseMs / 3));

  if (dedupeKey) {
    const existing = await findActiveTaskRunByDedupeKey(dedupeKey);
    if (existing) {
      await emitTaskEvent(existing.sessionId, 'task.deduplicated', existing, {
        duplicateTaskRunId: taskRunId,
      });
      await input.onTaskEvent?.({ type: 'task.deduplicated', taskRun: existing });
      return {
        status: 'deduplicated',
        sessionId: existing.sessionId,
        taskRun: existing,
      };
    }
  }

  const created = await createTaskRun({
    id: taskRunId,
    sessionId,
    runSpecId: input.runSpecId,
    traceId,
    dedupeKey,
    workspaceRoot,
    toolMode,
    provider: input.provider,
    model: input.model,
    tenantId: normalizeOptionalString(input.tenantId),
    projectId: normalizeOptionalString(input.projectId),
    userId: normalizeOptionalString(input.userId),
    nodeId,
    requestId: normalizeOptionalString(input.requestId),
    promptPreview: input.promptPreview ?? input.prompt.slice(0, 200),
    metadata: input.metadata ?? {},
    status: 'queued',
  });
  await emitTaskEvent(sessionId, 'task.created', created);
  await input.onTaskEvent?.({ type: 'task.created', taskRun: created });

  let running = await updateTaskRun(taskRunId, {
    status: 'running',
    nodeId,
    heartbeatAt: new Date(),
    leaseExpiresAt: new Date(Date.now() + leaseMs),
    metadata: {
      ...created.metadata,
      model: input.model,
      maxLoops: input.maxLoops,
      modelSettings: input.modelSettings,
      allowedTools: input.allowedTools,
      toolRetry: input.toolRetry,
      timeoutMs,
    },
  });
  running ??= await loadTaskRun(taskRunId);
  if (!running) throw new Error(`Task run disappeared after create: ${taskRunId}`);
  await emitTaskEvent(sessionId, 'task.running', running);
  await input.onTaskEvent?.({ type: 'task.running', taskRun: running });

  const controller = new AbortController();
  const linkedAbortCleanup = linkAbortSignal(input.signal, controller);
  let timeout: NodeJS.Timeout | undefined;
  const stopHeartbeat = startTaskHeartbeat(taskRunId, nodeId, leaseMs, heartbeatMs);
  runningTaskControllers.set(taskRunId, { controller, reason: 'cancelled' });
  if (timeoutMs) {
    timeout = setTimeout(() => {
      abortTaskController(taskRunId, `timeout:${timeoutMs}ms`);
    }, timeoutMs);
  }

  try {
    const result = executor
      ? await runAgentOnExecutor(executor, {
          taskRunId,
          leaseMs,
          prompt: input.prompt,
          config: {
            sessionId,
            provider: input.provider,
            model: input.model,
            modelSettings: input.modelSettings,
            maxLoops: input.maxLoops,
            systemPrompt: input.systemPrompt,
            workspaceRoot,
            tenantId: input.tenantId,
            projectId: input.projectId,
            userId: input.userId,
            nodeId,
            requestId: input.requestId,
            traceId,
            toolMode,
            initialMessages: input.initialMessages,
            allowedTools: input.allowedTools,
            toolRetry: input.toolRetry,
            mcpServers: input.mcpServers,
          },
          signal: controller.signal,
          onSessionEvent: input.onSessionEvent,
          onModelDelta: input.onModelDelta,
          onCheckpoint: input.onCheckpoint,
        })
      : await runAgent(input.prompt, {
          sessionId,
          provider: input.provider,
          model: input.model,
          modelSettings: input.modelSettings,
          maxLoops: input.maxLoops,
          systemPrompt: input.systemPrompt,
          workspaceRoot,
          tenantId: input.tenantId,
          projectId: input.projectId,
          userId: input.userId,
          nodeId,
          requestId: input.requestId,
          traceId,
          toolMode,
          initialMessages: input.initialMessages,
          allowedTools: input.allowedTools,
          toolRetry: input.toolRetry,
          mcpServers: input.mcpServers,
          signal: controller.signal,
          onSessionEvent: input.onSessionEvent,
          onTurn: input.onTurn,
          onToolCall: input.onToolCall,
          onModelDelta: input.onModelDelta,
          onCheckpoint: input.onCheckpoint,
        });

    const succeeded = await updateTaskRun(taskRunId, {
      status: 'succeeded',
      metadata: {
        ...running.metadata,
        loopCount: result.loopCount,
        totalTokens: result.totalTokens,
      },
    });
    const finalTask = succeeded ?? running;
    await emitTaskEvent(sessionId, 'task.succeeded', finalTask);
    await input.onTaskEvent?.({ type: 'task.succeeded', taskRun: finalTask });
    return {
      status: 'completed',
      sessionId,
      taskRun: finalTask,
      result,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isAbortError(err)) {
      const reason = runningTaskControllers.get(taskRunId)?.reason ?? message;
      const cancelled = await updateTaskRun(taskRunId, {
        status: 'cancelled',
        metadata: {
          ...running.metadata,
          cancelReason: reason,
        },
      });
      const finalTask = cancelled ?? running;
      await emitTaskEvent(sessionId, 'task.cancelled', finalTask, { reason });
      await input.onTaskEvent?.({ type: 'task.cancelled', taskRun: finalTask });
      return {
        status: 'cancelled',
        sessionId,
        taskRun: finalTask,
        reason,
      };
    }

    const failed = await updateTaskRun(taskRunId, {
      status: 'failed',
      metadata: {
        ...running.metadata,
        error: message,
      },
    });
    const finalTask = failed ?? running;
    await emitTaskEvent(sessionId, 'task.failed', finalTask, { message });
    await input.onTaskEvent?.({ type: 'task.failed', taskRun: finalTask });
    throw err;
  } finally {
    if (timeout) clearTimeout(timeout);
    stopHeartbeat();
    linkedAbortCleanup();
    runningTaskControllers.delete(taskRunId);
  }
}

export function cancelScheduledTask(taskRunId: string, reason = 'cancelled'): boolean {
  return abortTaskController(taskRunId, reason);
}

async function emitTaskEvent(
  sessionId: string,
  type: ScheduledTaskEventType,
  taskRun: TaskRunRecord,
  extraPayload: Record<string, unknown> = {},
): Promise<void> {
  await appendSessionEvent({
    sessionId,
    tenantId: taskRun.tenantId,
    projectId: taskRun.projectId,
    userId: taskRun.userId,
    nodeId: taskRun.nodeId,
    requestId: taskRun.requestId,
    traceId: taskRun.traceId,
    type,
    payload: {
      taskRunId: taskRun.id,
      traceId: taskRun.traceId,
      dedupeKey: taskRun.dedupeKey ?? null,
      workspaceRoot: taskRun.workspaceRoot,
      toolMode: taskRun.toolMode,
      provider: taskRun.provider ?? null,
      nodeId: taskRun.nodeId ?? null,
      requestId: taskRun.requestId ?? null,
      tenantId: taskRun.tenantId ?? null,
      projectId: taskRun.projectId ?? null,
      userId: taskRun.userId ?? null,
      heartbeatAt: taskRun.heartbeatAt ?? null,
      leaseExpiresAt: taskRun.leaseExpiresAt ?? null,
      status: taskRun.status,
      ...extraPayload,
    },
  });
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const int = Math.floor(value);
  return int > 0 ? int : undefined;
}

type ResolvedExecutor = {
  url: string;
  nodeId: string;
  agentKey?: string;
};

async function resolveExecutor(config: ScheduledExecutorConfig | undefined): Promise<ResolvedExecutor | null> {
  if (!config?.enabled) return null;

  if (config.nodeUrls && config.nodeUrls.length > 0) {
    const firstUrl = config.nodeUrls.map(normalizeExecutorUrl).find(Boolean);
    if (!firstUrl) {
      throw new Error('Executor is enabled but no executor node URL is configured');
    }
    return {
      url: firstUrl,
      nodeId: normalizeOptionalString(config.nodeId) ?? firstUrl,
      agentKey: normalizeOptionalString(config.agentKey),
    };
  }

  const candidates = (await listExecutorNodes(100)).filter(node => node.execution.candidate);
  const preferredNodeId = normalizeOptionalString(config.nodeId);
  const preferred = preferredNodeId ? candidates.find(node => node.nodeId === preferredNodeId) : undefined;
  const ordered = preferred ? [preferred, ...candidates.filter(node => node.nodeId !== preferred.nodeId)] : candidates;

  for (const node of ordered) {
    const url = resolveExecutorNodeUrl(node);
    if (url) {
      return {
        url,
        nodeId: node.nodeId,
        agentKey: normalizeOptionalString(config.agentKey),
      };
    }
  }

  if (candidates.length > 0) {
    throw new Error('Executor is enabled but candidate executor nodes have no runnable agent_http base URL');
  }
  throw new Error('Executor is enabled but no verified executor node candidate is available');
}

function resolveExecutorNodeUrl(node: ExecutorNodeRecord): string | null {
  const mode = node.execution.mode;
  const modeConfig = readObject(mode ? node.connectConfig[mode] : undefined);
  const agentHttpConfig = readObject(node.connectConfig.agent_http);
  const agentNdjsonConfig = readObject(node.connectConfig.agent_http_ndjson);
  const raw =
    readString(modeConfig.baseUrl) ??
    readString(modeConfig.endpoint) ??
    readString(agentHttpConfig.baseUrl) ??
    readString(agentHttpConfig.endpoint) ??
    readString(agentNdjsonConfig.baseUrl) ??
    readString(agentNdjsonConfig.endpoint) ??
    node.baseUrl;
  return raw ? normalizeExecutorUrl(stripExecutorEndpointPath(raw)) : null;
}

function stripExecutorEndpointPath(value: string): string {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.pathname === '/health') {
      url.pathname = '';
    } else if (url.pathname === '/v1/tasks/run-agent') {
      url.pathname = '';
    }
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return trimmed;
  }
}

function readObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeExecutorUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

function startTaskHeartbeat(
  taskRunId: string,
  nodeId: string,
  leaseMs: number,
  heartbeatMs: number,
): () => void {
  const interval = setInterval(() => {
    heartbeatTaskRun(taskRunId, { nodeId, leaseMs }).catch(() => undefined);
  }, heartbeatMs);
  void heartbeatTaskRun(taskRunId, { nodeId, leaseMs }).catch(() => undefined);
  return () => clearInterval(interval);
}

async function runAgentOnExecutor(
  executor: ResolvedExecutor,
  input: {
    taskRunId: string;
    leaseMs: number;
    prompt: string;
    config: Omit<AgentConfig, 'signal' | 'onSessionEvent' | 'onTurn' | 'onToolCall' | 'onCheckpoint'>;
    signal?: AbortSignal;
    onSessionEvent?: AgentConfig['onSessionEvent'];
    onModelDelta?: AgentConfig['onModelDelta'];
    onCheckpoint?: AgentConfig['onCheckpoint'];
  },
): Promise<AgentResult> {
  const res = await fetch(`${executor.url}/v1/tasks/run-agent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/x-ndjson, application/json',
      ...(executor.agentKey ? { 'Authorization': `Bearer ${executor.agentKey}` } : {}),
    },
    body: JSON.stringify({
      taskRunId: input.taskRunId,
      nodeId: executor.nodeId,
      leaseMs: input.leaseMs,
      prompt: input.prompt,
      config: input.config,
    }),
    signal: input.signal,
  });

  if (res.headers.get('content-type')?.includes('application/x-ndjson')) {
    return await readExecutorStreamResponse(res, executor, input);
  }

  const data = await readJsonResponse(res);
  if (!res.ok) {
    const message = typeof data?.error === 'string' ? data.error : `Executor ${executor.url} failed with ${res.status}`;
    throw new Error(message);
  }

  const events = Array.isArray(data?.events) ? data.events : [];
  for (const event of events) {
    await input.onSessionEvent?.(event);
  }
  const deltas = Array.isArray(data?.deltas) ? data.deltas : [];
  for (const delta of deltas) {
    await input.onModelDelta?.(delta);
  }
  if (!data?.result || typeof data.result !== 'object') {
    throw new Error(`Executor ${executor.url} returned no agent result`);
  }
  return data.result as AgentResult;
}

async function readExecutorStreamResponse(
  res: Response,
  executor: ResolvedExecutor,
  input: {
    onSessionEvent?: AgentConfig['onSessionEvent'];
    onModelDelta?: AgentConfig['onModelDelta'];
  },
): Promise<AgentResult> {
  if (!res.ok) {
    const error = await readJsonResponse(res);
    const message = typeof error?.error === 'string' ? error.error : `Executor ${executor.url} failed with ${res.status}`;
    throw new Error(message);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error(`Executor ${executor.url} returned no stream body`);

  const decoder = new TextDecoder();
  let buffer = '';
  let result: AgentResult | null = null;

  const processLine = async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const chunk = JSON.parse(trimmed) as {
      type?: string;
      event?: unknown;
      delta?: unknown;
      result?: unknown;
      error?: string;
    };
    if (chunk.type === 'session_event') {
      await input.onSessionEvent?.(chunk.event as any);
    } else if (chunk.type === 'model_delta') {
      await input.onModelDelta?.(chunk.delta as any);
    } else if (chunk.type === 'result') {
      result = chunk.result as AgentResult;
    } else if (chunk.type === 'error') {
      throw new Error(chunk.error ?? `Executor ${executor.url} stream failed`);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        await processLine(line);
      }
    }
    if (done) break;
  }
  await processLine(buffer);

  if (!result) throw new Error(`Executor ${executor.url} stream completed without an agent result`);
  return result;
}

async function readJsonResponse(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 500) };
  }
}

function abortTaskController(taskRunId: string, reason: string): boolean {
  const running = runningTaskControllers.get(taskRunId);
  if (!running) return false;
  running.reason = reason;
  if (!running.controller.signal.aborted) {
    running.controller.abort(createAbortError(reason));
  }
  return true;
}

function linkAbortSignal(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => undefined;
  if (source.aborted) {
    target.abort(source.reason);
    return () => undefined;
  }

  const onAbort = () => target.abort(source.reason);
  source.addEventListener('abort', onAbort, { once: true });
  return () => source.removeEventListener('abort', onAbort);
}

function createAbortError(reason: string): Error {
  const err = new Error(reason);
  err.name = 'AbortError';
  return err;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}
