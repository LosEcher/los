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
  /** Latest model.response model from the event ledger (requested ?? effective). */
  effectiveModel?: string | null;
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
  includeInternal?: boolean;
  /** High-water cursor (exclusive) for the next incremental poll; 0 on full pages. */
  since?: number;
  /** Present on since>0 responses: id to pass as the next `since`. */
  nextSince?: number;
  /** Present on since>0 responses: true when no new events exist. */
  unchanged?: boolean;
  /** Present on before>0 responses: upper bound used for this page. */
  before?: number;
  /** Present on before>0 responses: whether an older window exists. */
  hasMore?: boolean;
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

/** GET /sessions/:id/execution-observability — P0 run projection. */
export type ExecutionVersionEvidence = {
  status: 'known' | 'unknown';
  value: string | null;
  eventIds: number[];
};

export type ExecutionFingerprint = {
  status: 'known' | 'unknown';
  algorithm: 'sha256';
  hash: string | null;
  components: {
    prompt: ExecutionVersionEvidence;
    spec: ExecutionVersionEvidence;
    memory: ExecutionVersionEvidence;
    toolCatalog: ExecutionVersionEvidence;
  };
};

export type ExecutionDurationEvidence = {
  durationMs: number;
  eventIds: number[];
};

export type ExecutionCountEvidence = {
  count: number;
  eventIds: number[];
};

export type ExecutionTokenEvidence = {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  totalTokens: number;
  eventIds: number[];
};

export type ExecutionTurnWaterfall = {
  turn: number;
  modelWait: ExecutionDurationEvidence;
  toolWait: ExecutionDurationEvidence;
  retries: ExecutionCountEvidence;
  errors: ExecutionCountEvidence;
  denied: ExecutionCountEvidence;
  tokens: ExecutionTokenEvidence;
};

export type ExecutionFailureFacetCategory =
  | 'provider'
  | 'tool'
  | 'policy'
  | 'verification'
  | 'context'
  | 'recovery';

export type ExecutionFailureFacet = {
  category: ExecutionFailureFacetCategory;
  code: string;
  message: string | null;
  eventIds: number[];
  verificationRecordIds: string[];
};

export type ExecutionObservabilityProjection = {
  sessionId: string;
  fingerprint: ExecutionFingerprint;
  waterfall: ExecutionTurnWaterfall[];
  failureFacets: ExecutionFailureFacet[];
};
