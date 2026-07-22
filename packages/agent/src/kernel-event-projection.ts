import {
  type KernelEvent,
} from './execution-kernel.js';
import type { AgentConfig } from './loop.js';
import { appendSessionEvent, type SessionEventWrite } from './session-events.js';
import type { SessionEventRecord } from './session-events.js';

type KernelEventAppender = (input: SessionEventWrite) => Promise<SessionEventRecord | void>;

export function _createKernelEventProjector(
  context: AgentConfig,
  append: KernelEventAppender = appendSessionEvent,
): (event: KernelEvent) => Promise<void> {
  const sessionId = requireContext(context.sessionId, 'sessionId');
  const taskRunId = requireContext(context.taskRunId, 'taskRunId');
  const traceId = requireContext(context.traceId, 'traceId');

  return async event => {
    const record = await append(_projectKernelEvent(event, {
      ...context,
      sessionId,
      taskRunId,
      traceId,
    }));
    if (record) await context.onSessionEvent?.(record);
  };
}

export function _projectKernelEvent(
  event: KernelEvent,
  context: AgentConfig & { sessionId: string; taskRunId: string; traceId: string },
): SessionEventWrite {
  const evidence = summarizeKernelPayload(event);
  return {
    sessionId: context.sessionId,
    tenantId: context.tenantId,
    projectId: context.projectId,
    userId: context.userId,
    nodeId: context.nodeId,
    requestId: context.requestId,
    traceId: context.traceId,
    turn: event.turn,
    type: event.type,
    source: `los.kernel.${event.kernel.kind}`,
    model: readString(evidence.model),
    toolName: readString(evidence.toolName),
    usage: event.type === 'usage.recorded' ? readUsage(evidence) : undefined,
    visibility: 'audit',
    payload: {
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      kernel: event.kernel,
      runSpecId: context.runSpecId ?? null,
      taskRunId: context.taskRunId,
      messageId: event.messageId ?? null,
      toolCallId: event.toolCallId ?? null,
      evidence,
    },
  };
}

function summarizeKernelPayload(event: KernelEvent): Record<string, unknown> {
  const payload = event.payload;
  if (event.type === 'kernel.started') return pick(payload, ['runSpecId', 'taskRunId', 'sessionId', 'traceId']);
  if (event.type === 'turn.started') return {};
  if (event.type === 'message.delta') {
    const delta = readObject(payload.delta);
    return {
      provider: readString(delta.provider),
      model: readString(delta.model),
      textDeltaLength: readString(delta.textDelta)?.length ?? 0,
      reasoningDeltaLength: readString(delta.reasoningDelta)?.length ?? 0,
    };
  }
  if (event.type === 'message.completed') {
    return {
      textLength: readString(payload.text)?.length ?? 0,
      reasoningLength: readString(payload.reasoningContent)?.length ?? 0,
      toolCallCount: readArray(payload.toolCalls).length,
      toolNames: readArray(payload.toolCalls).map(readToolName).filter(Boolean),
    };
  }
  if (event.type === 'tool.requested') {
    const args = readObject(payload.args);
    return {
      toolName: readString(payload.tool),
      argumentKeys: Object.keys(args).sort(),
    };
  }
  if (event.type === 'tool.completed') {
    const transition = readObject(payload.transition);
    return {
      toolName: readString(transition.toolName),
      state: readString(transition.state),
      durationMs: readNumber(transition.durationMs),
      attempt: readNumber(transition.attempt),
      outputLength: readString(transition.outputSummary)?.length ?? 0,
      error: truncate(readString(transition.error), 500),
    };
  }
  if (event.type === 'usage.recorded') return readObject(payload.totalTokens);
  if (event.type === 'checkpoint.created') {
    const checkpoint = readObject(payload.checkpoint);
    const value = readObject(checkpoint.value);
    return {
      codec: readString(checkpoint.codec),
      kernel: readObject(checkpoint.kernel),
      messageCount: readArray(value.messages).length,
      turnCount: readArray(value.turns).length,
    };
  }
  if (event.type === 'turn.completed') {
    const summary = readObject(payload.summary);
    return {
      textLength: readString(summary.text)?.length ?? 0,
      reasoningLength: readString(summary.reasoningContent)?.length ?? 0,
      toolCallCount: readArray(summary.toolCalls).length,
      toolResultCount: readArray(summary.toolResults).length,
    };
  }
  if (event.type === 'kernel.finished') {
    const result = readObject(payload.result);
    return {
      textLength: readString(result.text)?.length ?? 0,
      loopCount: readNumber(result.loopCount),
      messageCount: readArray(result.messages).length,
      turnCount: readArray(result.turns).length,
      totalTokens: readObject(result.totalTokens),
    };
  }
  if (event.type === 'kernel.interrupted') {
    return { reason: truncate(readString(payload.reason), 500) };
  }
  return { error: truncate(readString(payload.error), 500) };
}

function readUsage(value: Record<string, unknown>): SessionEventWrite['usage'] {
  const promptTokens = readNumber(value.prompt) ?? 0;
  const completionTokens = readNumber(value.completion) ?? 0;
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

function pick(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map(key => [key, value[key] ?? null]));
}

function readToolName(value: unknown): string | undefined {
  const toolCall = readObject(value);
  return readString(readObject(toolCall.function).name);
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function truncate(value: string | undefined, limit: number): string | null {
  if (!value) return null;
  return value.length <= limit ? value : `${value.slice(0, limit)}...[truncated]`;
}

function requireContext(value: string | undefined, name: string): string {
  if (value) return value;
  throw new Error(`Kernel event projection requires ${name}`);
}
