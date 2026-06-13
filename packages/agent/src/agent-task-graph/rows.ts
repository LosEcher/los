import {
  toIsoString,
  normalizeJsonObject,
  normalizeJsonStringArray,
} from './normalizers.js';
import type {
  AgentTaskRecord,
  AgentTaskEdgeRecord,
  AgentTaskAttemptRecord,
} from './types.js';

export type AgentTaskRow = {
  id: string;
  graph_id: string;
  run_spec_id: string | null;
  session_id: string | null;
  role: string;
  title: string;
  prompt: string | null;
  status: string;
  priority: number;
  confidence: number | null;
  cost_estimate: number | null;
  deadline_at: Date | string | null;
  max_attempts: number;
  metadata_json: unknown;
  claimed_by_node_id: string | null;
  lease_expires_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
};

export type AgentTaskEdgeRow = {
  graph_id: string;
  task_id: string;
  depends_on_task_id: string;
  kind: string;
  metadata_json: unknown;
  created_at: Date | string;
};

export type AgentTaskAttemptRow = {
  id: string;
  graph_id: string;
  task_id: string;
  attempt: number;
  status: string;
  provider: string | null;
  model: string | null;
  node_id: string | null;
  task_run_id: string | null;
  verification_record_id: string | null;
  tool_call_state_ids_json: unknown;
  output_summary: string | null;
  error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
};

export function rowToTask(row: AgentTaskRow): AgentTaskRecord {
  return {
    id: row.id,
    graphId: row.graph_id,
    runSpecId: row.run_spec_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    role: row.role as AgentTaskRecord['role'],
    title: row.title,
    prompt: row.prompt ?? undefined,
    status: row.status as AgentTaskRecord['status'],
    priority: row.priority,
    confidence: row.confidence ?? undefined,
    costEstimate: row.cost_estimate ?? undefined,
    deadlineAt: row.deadline_at ? toIsoString(row.deadline_at) : undefined,
    maxAttempts: row.max_attempts,
    metadata: normalizeJsonObject(row.metadata_json),
    claimedByNodeId: row.claimed_by_node_id ?? undefined,
    leaseExpiresAt: row.lease_expires_at ? toIsoString(row.lease_expires_at) : undefined,
    startedAt: row.started_at ? toIsoString(row.started_at) : undefined,
    completedAt: row.completed_at ? toIsoString(row.completed_at) : undefined,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

export function rowToEdge(row: AgentTaskEdgeRow): AgentTaskEdgeRecord {
  return {
    graphId: row.graph_id,
    taskId: row.task_id,
    dependsOnTaskId: row.depends_on_task_id,
    kind: row.kind as AgentTaskEdgeRecord['kind'],
    metadata: normalizeJsonObject(row.metadata_json),
    createdAt: toIsoString(row.created_at),
  };
}

export function rowToAttempt(row: AgentTaskAttemptRow): AgentTaskAttemptRecord {
  return {
    id: row.id,
    graphId: row.graph_id,
    taskId: row.task_id,
    attempt: row.attempt,
    status: row.status as AgentTaskAttemptRecord['status'],
    provider: row.provider ?? undefined,
    model: row.model ?? undefined,
    nodeId: row.node_id ?? undefined,
    taskRunId: row.task_run_id ?? undefined,
    verificationRecordId: row.verification_record_id ?? undefined,
    toolCallStateIds: normalizeJsonStringArray(row.tool_call_state_ids_json),
    outputSummary: row.output_summary ?? undefined,
    error: row.error ?? undefined,
    startedAt: row.started_at ? toIsoString(row.started_at) : toIsoString(new Date()),
    completedAt: row.completed_at ? toIsoString(row.completed_at) : undefined,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}
