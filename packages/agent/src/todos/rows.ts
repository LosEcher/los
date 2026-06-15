import type { TodoKind, TodoPriority, TodoRecord, TodoStatus } from '../todo-types.js';
import { normalizeJsonObject, toIsoString } from './normalizers.js';

export type TodoRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  user_id: string | null;
  node_id: string | null;
  stage_id: string | null;
  parent_id: string | null;
  title: string;
  description: string;
  kind: TodoKind;
  status: TodoStatus;
  priority: TodoPriority;
  source: string;
  trace_id: string | null;
  request_id: string | null;
  dedupe_key: string | null;
  task_run_id: string | null;
  session_id: string | null;
  batch_key: string | null;
  archived_at: Date | string | null;
  archive_reason: string | null;
  metadata_json: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  cancelled_at: Date | string | null;
  reopened_at: Date | string | null;
};

export function rowToTodo(row: TodoRow, relations?: { dependsOnIds?: string[]; blockedByIds?: string[] }): TodoRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    userId: row.user_id ?? undefined,
    nodeId: row.node_id ?? undefined,
    stageId: row.stage_id ?? undefined,
    parentId: row.parent_id ?? undefined,
    title: row.title,
    description: row.description,
    kind: row.kind,
    status: row.status,
    priority: row.priority,
    source: row.source,
    traceId: row.trace_id ?? undefined,
    requestId: row.request_id ?? undefined,
    dedupeKey: row.dedupe_key ?? undefined,
    taskRunId: row.task_run_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    batchKey: row.batch_key ?? undefined,
    dependsOnIds: relations?.dependsOnIds ?? [],
    blockedByIds: relations?.blockedByIds ?? [],
    archivedAt: row.archived_at ? toIsoString(row.archived_at) : undefined,
    archiveReason: row.archive_reason ?? undefined,
    metadata: normalizeJsonObject(row.metadata_json),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    startedAt: row.started_at ? toIsoString(row.started_at) : undefined,
    completedAt: row.completed_at ? toIsoString(row.completed_at) : undefined,
    cancelledAt: row.cancelled_at ? toIsoString(row.cancelled_at) : undefined,
    reopenedAt: row.reopened_at ? toIsoString(row.reopened_at) : undefined,
  };
}
