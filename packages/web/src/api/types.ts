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
  runSpecId?: string;
  traceId: string;
  dedupeKey?: string;
  nodeId?: string;
  workspaceRoot: string;
  toolMode: string;
  provider?: string;
  model?: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  attempt: number;
  promptPreview: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  heartbeatAt?: string;
  leaseExpiresAt?: string;
};

export type ExecutorNode = {
  nodeId: string;
  nodeKind: 'executor' | 'ssh_target' | 'ingress' | 'proxy';
  baseUrl?: string;
  hostLabel?: string;
  status: 'online' | 'draining' | 'offline';
  version?: string;
  targetVersion?: string;
  rolloutState?: 'idle' | 'draining' | 'upgrading' | 'verifying' | 'failed';
  rolloutMessage?: string;
  connectModes: string[];
  connectConfig: Record<string, unknown>;
  capacity: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  verified: Record<string, unknown>;
  queueDepth: number;
  activeTaskCount: number;
  meshLinks: Array<Record<string, unknown>>;
  lastProbeAt?: string;
  lastProbeError?: string;
  lastHeartbeatAt: string;
  createdAt: string;
  updatedAt: string;
  execution: {
    candidate: boolean;
    mode?: string;
    blockers: string[];
    warnings: string[];
  };
};

export type ExecutorNodeUpsertPayload = {
  nodeKind?: ExecutorNode['nodeKind'];
  baseUrl?: string;
  hostLabel?: string;
  status?: ExecutorNode['status'];
  version?: string;
  targetVersion?: string;
  rolloutState?: ExecutorNode['rolloutState'];
  rolloutMessage?: string;
  connectModes?: ExecutorNode['connectModes'] | string;
  connectConfig?: Record<string, unknown>;
  capacity?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  verified?: Record<string, unknown>;
  queueDepth?: number;
  activeTaskCount?: number;
  meshLinks?: Array<Record<string, unknown>>;
};

export type ExecutorNodeProbeResponse = {
  ok: boolean;
  node: ExecutorNode;
  probe: {
    status: ExecutorNode['status'];
    verified: Record<string, unknown>;
    lastProbeError?: string;
  };
};

export type SshConfigImportResponse = {
  ok: boolean;
  dryRun: boolean;
  conflictStrategy: 'preserve_existing' | 'overwrite';
  summary: {
    created: number;
    updated: number;
    skipped: number;
    failed: number;
    total: number;
  };
  items: Array<{
    alias: string;
    hostName: string;
    user?: string;
    port: number;
    nodeId: string;
    matchedNodeId?: string;
    action: 'create' | 'update' | 'skip_no_match' | 'error';
    willWrite: boolean;
    error?: string;
    node?: ExecutorNodeUpsertPayload & { nodeId: string };
  }>;
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
  content: string;
  metadata: Record<string, unknown>;
  source: string;
  sessionId?: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  nodeId?: string;
  requestId?: string;
  traceId?: string;
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
  byScope: Record<string, number>;
  byLayer: Record<string, number>;
  archived: number;
};

export type ProviderReadiness = {
  configuredKey?: boolean;
  discovered?: boolean;
  ready?: boolean;
  manualSetupRequired?: boolean;
  blocker?: string | null;
};

export type ProviderDiscoveryProvider = Record<string, unknown> & {
  name?: string;
  provider?: string;
  source?: string;
  defaultModel?: string;
  model?: string;
  hasApiKey?: boolean;
  readiness?: ProviderReadiness;
};

export type ProviderDiscovery = {
  providers?: ProviderDiscoveryProvider[];
  tools?: Array<Record<string, unknown>>;
  summary?: string;
};

export type ProviderModelInfo = {
  id: string;
  object?: string;
  ownedBy?: string;
};

export type ProviderModelsResponse = {
  provider: string | null;
  count: number;
  providers: Array<{
    provider: string;
    ok: boolean;
    enabled?: boolean;
    hasApiKey?: boolean;
    source?: string | null;
    model?: string | null;
    baseUrl?: string | null;
    count?: number;
    error?: string;
    models: ProviderModelInfo[];
    profile?: Record<string, unknown>;
  }>;
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
  branchFrom?: string;
  branchAtTurn?: number;
  systemPrompt?: string;
  provider?: string;
  model?: string;
  modelSettings?: ModelSettings;
  workspaceRoot?: string;
  toolMode: ToolMode;
  allowedTools?: string[];
  maxLoops?: number;
  traceId?: string;
  dedupeKey?: string;
  timeoutMs?: number;
  toolRetry?: ToolRetry;
  mcpServers?: MCPServerPayload[];
  runContract?: Record<string, unknown>;
  persistMemory?: boolean;
  todoId?: string;
};

export type ToolRetry = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

export type MCPServerPayload = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type MCPTransport = 'stdio' | 'sse' | 'streamable-http';
export type MCPServerStatus = 'unverified' | 'connected' | 'error' | 'disabled';

export type MCPServer = {
  id: string;
  tenantId?: string;
  projectId?: string;
  transport: MCPTransport;
  command?: string;
  args: string[];
  url?: string;
  env: Record<string, string>;
  enabled: boolean;
  status: MCPServerStatus;
  lastError?: string;
  toolCount: number;
  tools: MCPRegisteredTool[];
  createdAt: string;
  updatedAt: string;
};

export type MCPRegisteredTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export type MCPServerListResponse = {
  count: number;
  servers: MCPServer[];
};

export type MCPServerVerifyResponse = {
  ok: boolean;
  serverId: string;
  toolCount?: number;
  tools?: Array<{ name: string; description?: string }>;
  error?: string;
};

export type ServiceInstance = {
  serviceId: string;
  serviceKind: string;
  hostLabel: string;
  bindUrl?: string;
  publicUrl?: string;
  version?: string;
  role: string;
  status: string;
  rolloutState?: string;
  rolloutMessage?: string;
  capabilities: Record<string, unknown>;
  health: Record<string, unknown>;
  load: Record<string, unknown>;
  priority: number;
  readiness: { ready: boolean; blockers: string[]; warnings: string[] };
  createdAt: string;
  updatedAt: string;
  lastHeartbeatAt: string;
};

export type ArtifactRecord = {
  id: string;
  artifactId: string;
  sessionId?: string;
  taskRunId?: string;
  nodeId?: string;
  path: string;
  size: number;
  mimeType?: string;
  contentHash?: string;
  createdAt: string;
};

export type ArtifactListResponse = {
  count: number;
  artifacts: ArtifactRecord[];
};

export type AgentTaskRole = 'planner' | 'executor' | 'verifier';
export type AgentTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type AgentTaskAttemptStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export type AgentTaskGraphTask = {
  id: string;
  graphId: string;
  runSpecId?: string;
  sessionId?: string;
  role: AgentTaskRole;
  title: string;
  prompt?: string;
  status: AgentTaskStatus;
  priority: number;
  confidence?: number;
  costEstimate?: number;
  deadlineAt?: string;
  maxAttempts: number;
  metadata: Record<string, unknown>;
  claimedByNodeId?: string;
  leaseExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
};

export type AgentTaskGraphEdge = {
  graphId: string;
  taskId: string;
  dependsOnTaskId: string;
  kind: 'blocks';
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type AgentTaskGraphAttempt = {
  id: string;
  graphId: string;
  taskId: string;
  attempt: number;
  status: AgentTaskAttemptStatus;
  provider?: string;
  model?: string;
  nodeId?: string;
  taskRunId?: string;
  verificationRecordId?: string;
  toolCallStateIds: string[];
  outputSummary?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type AgentTaskGraphCompletion = {
  graphId: string;
  status: string;
  canComplete: boolean;
  reason: string;
  blockReason?: string;
  counts: {
    total: number;
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    verifier: number;
    succeededVerifier: number;
  };
  readyTaskIds: string[];
  waitingTaskIds: string[];
  blockedTaskIds: string[];
  runningTaskIds: string[];
  failedTaskIds: string[];
  failedVerifierTaskIds: string[];
  cancelledTaskIds: string[];
  verifierTaskIds: string[];
  succeededVerifierTaskIds: string[];
};

export type AgentTaskGraph = {
  graphId: string;
  tasks: AgentTaskGraphTask[];
  edges: AgentTaskGraphEdge[];
  attemptsByTaskId: Record<string, AgentTaskGraphAttempt[]>;
  completion: AgentTaskGraphCompletion;
};

export type RunSpec = {
  id: string;
  sessionId: string;
  taskRunId?: string;
  status: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type NodeCommandRecord = {
  id: string;
  nodeId: string;
  command: string;
  status: string;
  requestedBy?: string;
  result?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ModelSettings = {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
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
