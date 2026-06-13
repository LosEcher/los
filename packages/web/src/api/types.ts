import type { ExecutorNodeUpsertPayload } from './types-executor-nodes.js';
export * from './types-executor-nodes.js';
export * from './types-sessions.js';
export * from './types-mcp.js';
export * from './types-agent-task-graph.js';
import type { ToolRetry, MCPServerPayload } from './types-mcp.js';
import type { ToolMode } from './types-sessions.js';

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

export type ProviderModelRoute = {
  provider: string; ok: boolean; models: ProviderModelInfo[];
  enabled?: boolean; hasApiKey?: boolean; source?: string | null; model?: string | null;
  baseUrl?: string | null; count?: number; error?: string; profile?: Record<string, unknown>;
};

export type ProviderModelRecord = {
  provider: string; model: string; source?: string | null;
  enabled?: boolean; hasApiKey?: boolean; baseUrl?: string | null;
};

export type ProviderModelsResponse = {
  provider: string | null;
  count: number;
  providers?: ProviderModelRoute[];
  models?: ProviderModelRecord[];
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

// ── Project binding ──────────────────────────────────

export type ProjectBinding = {
  projectId: string;
  displayName: string;
  workspacePath: string;
  createdAt: string;
  lastUsed: string;
};

export type ProjectListResponse = {
  projects: ProjectBinding[];
  defaultProjectId: string | null;
};

export type ProjectBrowseResponse = {
  path: string; parent: string | null;
  roots: Array<{ label: string; path: string }>;
  entries: Array<{ name: string; path: string; hidden: boolean }>;
};
