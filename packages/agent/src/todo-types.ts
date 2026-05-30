export type TodoKind = 'problem' | 'solution' | 'plan' | 'phase' | 'task' | 'batch';
export type TodoStatus = 'backlog' | 'ready' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
export type TodoPriority = 'P0' | 'P1' | 'P2' | 'P3';

export interface TodoRecord {
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
}

export interface CreateTodoInput {
  id?: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  nodeId?: string;
  stageId?: string;
  parentId?: string;
  title: string;
  description?: string;
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
}

export interface UpdateTodoInput {
  title?: string;
  description?: string;
  kind?: TodoKind;
  status?: TodoStatus;
  priority?: TodoPriority;
  userId?: string | null;
  nodeId?: string | null;
  stageId?: string | null;
  parentId?: string | null;
  traceId?: string | null;
  requestId?: string | null;
  dedupeKey?: string | null;
  taskRunId?: string | null;
  sessionId?: string | null;
  batchKey?: string | null;
  dependsOnIds?: string[] | null;
  metadata?: Record<string, unknown>;
}

export interface ListTodosOptions {
  tenantId?: string;
  projectId?: string;
  status?: TodoStatus;
  kind?: TodoKind;
  limit?: number;
  includeArchived?: boolean;
}
