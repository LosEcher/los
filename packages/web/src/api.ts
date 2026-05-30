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
  createdAt: string;
};

export type SessionEventsResponse = {
  sessionId: string;
  count: number;
  events: SessionEvent[];
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

export type TaskRun = {
  id: string;
  sessionId: string;
  traceId: string;
  dedupeKey?: string;
  workspaceRoot: string;
  toolMode: string;
  provider?: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  attempt: number;
  promptPreview: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
};

export type TodoKind = 'problem' | 'solution' | 'plan' | 'phase' | 'task' | 'batch';
export type TodoStatus = 'backlog' | 'ready' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
export type TodoPriority = 'P0' | 'P1' | 'P2' | 'P3';

export type TodoItem = {
  id: string;
  tenantId: string;
  projectId: string;
  userId?: string;
  nodeId?: string;
  stageId?: string;
  parentId?: string;
  title: string;
  description: string;
  kind: TodoKind;
  status: TodoStatus;
  priority: TodoPriority;
  source: string;
  traceId?: string;
  requestId?: string;
  dedupeKey?: string;
  taskRunId?: string;
  sessionId?: string;
  batchKey?: string;
  dependsOnIds: string[];
  blockedByIds: string[];
  archivedAt?: string;
  archiveReason?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  reopenedAt?: string;
};

export type MemoryObservation = {
  id: number;
  title: string;
  summary: string;
  kind: string;
  tags: string[];
  source: string;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
};

export type MemoryResponse = {
  count: number;
  results: MemoryObservation[];
};

export type MemoryStats = {
  totalObservations: number;
  byKind: Record<string, number>;
  bySource: Record<string, number>;
};

export type ProviderDiscovery = {
  providers?: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  summary?: string;
};

export type LogFile = {
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
};

export type LogEntry = {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  package?: string;
  message: string;
  raw: string;
};

export type LogsResponse = {
  file: string;
  path: string;
  count: number;
  entries: LogEntry[];
};

export type ChatPayload = {
  prompt: string;
  sessionId?: string;
  provider?: string;
  workspaceRoot?: string;
  toolMode: ToolMode;
  maxLoops?: number;
  timeoutMs?: number;
};

export type TodoPayload = {
  title: string;
  description?: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  nodeId?: string;
  stageId?: string;
  parentId?: string;
  kind?: TodoKind;
  status?: TodoStatus;
  priority?: TodoPriority;
  source?: string;
  traceId?: string;
  requestId?: string;
  dedupeKey?: string;
  taskRunId?: string;
  sessionId?: string;
  batchKey?: string;
  dependsOnIds?: string[];
  metadata?: Record<string, unknown>;
};

export type StreamEvent = {
  event: string;
  data: Record<string, unknown>;
};

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return await res.json() as T;
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return await res.json() as T;
}

export async function deleteJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return await res.json() as T;
}

export async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return await res.json() as T;
}

export async function streamChat(
  payload: ChatPayload,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const res = await fetch('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`${res.status} ${res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventName = line.slice(7).trim();
        continue;
      }
      if (line.startsWith('data: ')) {
        const data = JSON.parse(line.slice(6)) as Record<string, unknown>;
        onEvent({ event: eventName, data });
        eventName = 'message';
      }
    }
  }
}
