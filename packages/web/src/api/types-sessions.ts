export type ToolMode = 'read-only' | 'project-write' | 'all';

export type Health = {
  status: string;
  uptime: number;
};

export type SessionSummary = {
  id: string;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
};

export type SessionDetail = SessionSummary & {
  messages: Array<Record<string, unknown>>;
  turns: Array<Record<string, unknown>>;
};

export type SessionEvent = {
  id: number;
  sessionId: string;
  turn: number;
  type: string;
  source: string;
  model?: string;
  toolName?: string;
  payload: Record<string, unknown>;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
    totalTokens: number;
  };
  cacheKey?: string;
  cacheHit?: boolean;
  parentEventId?: number;
  createdAt: string;
};

export type SessionEventsResponse = {
  sessionId: string;
  count: number;
  events: SessionEvent[];
};

export type TraceToolCall = {
  callId: string;
  toolName: string;
  status: 'running' | 'completed' | 'error' | 'denied';
  argsPreview: string;
  args?: Record<string, unknown>;
  resultPreview?: string;
  errorPreview?: string;
  durationMs?: number;
  attempts?: number;
};

export type TraceMessage = {
  role: 'user' | 'assistant' | 'system' | 'separator';
  content: string;
  meta?: string;
  level?: 'normal' | 'ok' | 'warn' | 'error';
  eventType?: string;
  provider?: string;
  model?: string;
  turnIndex?: number;
  totalTurns?: number;
  reasoning?: string;
  toolCalls: TraceToolCall[];
};

export type SessionTraceResponse = {
  sessionId: string;
  messageCount: number;
  turnCount: number;
  messages: TraceMessage[];
};

export type SessionObservability = {
  sessionId: string;
  eventCount: number;
  turnCount: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
  totalUsage: {
    promptTokens: number;
    completionTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
    totalTokens: number;
  };
  cache: {
    status: string;
    hitRate: number;
    keys: string[];
  };
  tools: {
    status: string;
    count: number;
    names: string[];
  };
  models: {
    status: string;
    count: number;
    names: string[];
  };
};
