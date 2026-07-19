import type { Message } from './providers/index.js';
import { sessionEventVisibility, type SessionEventRecord, type SessionEventUsage, type SessionEventWrite } from './session-events.js';
import type { SessionTraceProjection } from './session-trace.js';
import type { SessionRecord } from './session.js';
import type { TurnSummary } from './loop.js';

const USAGE: SessionEventUsage = {
  promptTokens: 120,
  completionTokens: 45,
  cacheHitTokens: 10,
  cacheMissTokens: 20,
  totalTokens: 165,
};

export const GOLDEN_SESSION_TRACE_SESSION_ID = 'session-trace-golden';
export const GOLDEN_SESSION_TRACE_CALL_ID = 'call-golden-read-file';

export const GOLDEN_SESSION_TRACE_MESSAGES: Message[] = [
  { role: 'user', content: '检查 AGENTS.md 的运行规则。' } as Message,
  {
    role: 'assistant',
    content: '已检查 AGENTS.md，关键规则是先读项目约束再改代码。',
    tool_calls: [{
      id: GOLDEN_SESSION_TRACE_CALL_ID,
      type: 'function',
      function: { name: 'read_file', arguments: '{"path":"AGENTS.md"}' },
    }],
  } as unknown as Message,
];

export const GOLDEN_SESSION_TRACE_TURNS: TurnSummary[] = [
  {
    loopCount: 1,
    text: '已检查 AGENTS.md，关键规则是先读项目约束再改代码。',
    toolCalls: [],
    toolResults: [],
    reasoningContent: '需要先读取项目规则，再决定是否可以编辑。',
  } as TurnSummary,
];

export const GOLDEN_SESSION_TRACE_EVENT_WRITES: Array<Omit<SessionEventWrite, 'sessionId'>> = [
  {
    type: 'session.started',
    payload: {
      requestedProvider: 'deepseek',
      requestedModel: 'deepseek-chat',
      effectiveProvider: 'deepseek',
      effectiveModel: 'deepseek-chat',
      routeReason: 'explicit_fallback_policy',
    },
  },
  {
    type: 'provider.fallback.selected',
    turn: 1,
    model: 'grok-4.3',
    payload: {
      policyMode: 'explicit_ordered',
      callIndex: 1,
      switchIndex: 1,
      failureClass: 'rate_limit',
      fromProvider: 'deepseek',
      fromModel: 'deepseek-chat',
      toProvider: 'xai',
      toModel: 'grok-4.3',
      compatibilityEvidenceId: 'compat-golden-xai',
    },
  },
  {
    type: 'model.response',
    turn: 1,
    model: 'grok-4.3',
    usage: USAGE,
    payload: {
      provider: 'xai',
      durationMs: 321,
      textPreview: '我会先检查 AGENTS.md。',
      reasoningPreview: '需要先读取项目规则。',
    },
  },
  {
    type: 'tool.call',
    turn: 1,
    toolName: 'read_file',
    payload: {
      callId: GOLDEN_SESSION_TRACE_CALL_ID,
      args: { path: 'AGENTS.md' },
    },
  },
  {
    type: 'tool.result',
    turn: 1,
    toolName: 'read_file',
    payload: {
      callId: GOLDEN_SESSION_TRACE_CALL_ID,
      ok: true,
      durationMs: 42,
      attempts: 1,
      contentPreview: '# los AGENTS',
    },
  },
  {
    type: 'session.completed',
    turn: 1,
    payload: { status: 'succeeded' },
  },
];

export const GOLDEN_SESSION_TRACE_PROJECTION: SessionTraceProjection = {
  sessionId: GOLDEN_SESSION_TRACE_SESSION_ID,
  turns: [{
    turn: 1,
    provider: 'xai',
    model: 'grok-4.3',
    durationMs: 321,
    usage: USAGE,
    toolCalls: [{
      callId: GOLDEN_SESSION_TRACE_CALL_ID,
      toolName: 'read_file',
      turn: 1,
      status: 'completed',
      argsPreview: '{"path":"AGENTS.md"}',
      args: { path: 'AGENTS.md' },
      resultPreview: '# los AGENTS',
      errorPreview: undefined,
      durationMs: 42,
      attempts: 1,
    }],
  }],
};

export const GOLDEN_SESSION_TRACE_MESSAGES_VIEW = [
  {
    role: 'user',
    content: '检查 AGENTS.md 的运行规则。',
    toolCalls: [],
  },
  {
    role: 'assistant',
    content: '已检查 AGENTS.md，关键规则是先读项目约束再改代码。',
    reasoning: '需要先读取项目规则，再决定是否可以编辑。',
    provider: 'xai',
    model: 'grok-4.3',
    turnIndex: 1,
    totalTurns: 1,
    toolCalls: [{
      callId: GOLDEN_SESSION_TRACE_CALL_ID,
      toolName: 'read_file',
      status: 'completed',
      argsPreview: '{"path":"AGENTS.md"}',
      args: { path: 'AGENTS.md' },
      resultPreview: '# los AGENTS',
      durationMs: 42,
      attempts: 1,
    }],
  },
];

export function buildGoldenSessionTraceSession(sessionId = GOLDEN_SESSION_TRACE_SESSION_ID): SessionRecord {
  return {
    id: sessionId,
    createdAt: '2026-06-13T00:00:00.000Z',
    updatedAt: '2026-06-13T00:00:00.000Z',
    metadata: { prompt: '检查 AGENTS.md 的运行规则。' },
    messages: GOLDEN_SESSION_TRACE_MESSAGES,
    turns: GOLDEN_SESSION_TRACE_TURNS,
  };
}

export function buildGoldenSessionTraceRecords(sessionId = GOLDEN_SESSION_TRACE_SESSION_ID): SessionEventRecord[] {
  return GOLDEN_SESSION_TRACE_EVENT_WRITES.map((event, index) => ({
    id: index + 1,
    sessionId,
    turn: event.turn ?? 0,
    type: event.type,
    source: event.source ?? 'los',
    model: event.model,
    toolName: event.toolName,
    cacheKey: event.cacheKey,
    cacheHit: event.cacheHit,
    usage: normalizeUsage(event.usage),
    parentEventId: event.parentEventId,
    payload: event.payload ?? {},
    visibility: event.visibility ?? sessionEventVisibility(event.type),
    createdAt: `2026-06-13T00:00:0${index}.000Z`,
  }));
}

function normalizeUsage(value: Partial<SessionEventUsage> | undefined): SessionEventUsage {
  return {
    promptTokens: value?.promptTokens ?? 0,
    completionTokens: value?.completionTokens ?? 0,
    cacheHitTokens: value?.cacheHitTokens ?? 0,
    cacheMissTokens: value?.cacheMissTokens ?? 0,
    totalTokens: value?.totalTokens ?? 0,
  };
}
