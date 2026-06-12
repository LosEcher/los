import type { EditableSurfaceConflictMode } from '../agent-task-editable-surfaces.js';

export type AgentTaskRole = 'planner' | 'executor' | 'verifier';
export type AgentTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'blocked';
export type AgentTaskAttemptStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface AgentTaskRecord {
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
}

export interface AgentTaskAttemptRecord {
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
}

export interface AgentTaskEdgeRecord {
  graphId: string;
  taskId: string;
  dependsOnTaskId: string;
  kind: 'blocks';
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface CreateAgentTaskInput {
  id: string;
  graphId: string;
  runSpecId?: string;
  sessionId?: string;
  role: AgentTaskRole;
  title: string;
  prompt?: string;
  status?: AgentTaskStatus;
  priority?: number;
  confidence?: number;
  costEstimate?: number;
  deadlineAt?: Date | string;
  maxAttempts?: number;
  metadata?: Record<string, unknown>;
}

export interface LinkAgentTaskDependencyInput {
  graphId: string;
  taskId: string;
  dependsOnTaskId: string;
  metadata?: Record<string, unknown>;
}

export interface ClaimReadyAgentTasksInput {
  graphId: string;
  limit?: number;
  nodeId?: string;
  leaseMs?: number;
  editableSurfaceMode?: EditableSurfaceConflictMode;
}

export interface CreateAgentTaskAttemptInput {
  id: string;
  graphId: string;
  taskId: string;
  attempt?: number;
  status?: AgentTaskAttemptStatus;
  provider?: string;
  model?: string;
  nodeId?: string;
  taskRunId?: string;
  verificationRecordId?: string;
  toolCallStateIds?: string[];
  outputSummary?: string;
  error?: string;
}
