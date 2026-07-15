import type { TaskRunRecord, TaskRunStatus } from '../task-runs.js';
import { normalizeJsonObject, toIsoString } from './normalizers.js';

export type TaskRunRow = {
  id: string;
  session_id: string;
  run_spec_id: string | null;
  trace_id: string | null;
  dedupe_key: string | null;
  tenant_id: string | null;
  project_id: string | null;
  user_id: string | null;
  node_id: string | null;
  request_id: string | null;
  workspace_root: string;
  tool_mode: string;
  provider: string | null;
  model: string | null;
  status: TaskRunStatus;
  attempt: number | null;
  prompt_preview: string;
  metadata_json: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  heartbeat_at: Date | string | null;
  lease_version: number | string;
  lease_expires_at: Date | string | null;
};

export function rowToTaskRun(row: TaskRunRow): TaskRunRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    runSpecId: row.run_spec_id ?? undefined,
    traceId: row.trace_id ?? row.id,
    dedupeKey: row.dedupe_key ?? undefined,
    tenantId: row.tenant_id ?? undefined,
    projectId: row.project_id ?? undefined,
    userId: row.user_id ?? undefined,
    nodeId: row.node_id ?? undefined,
    requestId: row.request_id ?? undefined,
    workspaceRoot: row.workspace_root,
    toolMode: row.tool_mode,
    provider: row.provider ?? undefined,
    model: row.model ?? undefined,
    status: row.status,
    attempt: row.attempt ?? 1,
    promptPreview: row.prompt_preview,
    metadata: normalizeJsonObject(row.metadata_json),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    startedAt: row.started_at ? toIsoString(row.started_at) : undefined,
    completedAt: row.completed_at ? toIsoString(row.completed_at) : undefined,
    heartbeatAt: row.heartbeat_at ? toIsoString(row.heartbeat_at) : undefined,
    leaseVersion: Number(row.lease_version ?? 0),
    leaseExpiresAt: row.lease_expires_at ? toIsoString(row.lease_expires_at) : undefined,
  };
}
