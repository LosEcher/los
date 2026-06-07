import type { EditableSurfaceConflictMode } from '../agent-task-editable-surfaces.js';
import type { AgentTaskAttemptStatus } from '../agent-task-graph.js';
import type { AgentTaskGraphCompletion } from '../agent-task-graph-read-model.js';
import type { AgentConfig, AgentResult } from '../loop.js';
import type { RunContractMetadataInput } from '../run-contract.js';
import type { TaskRunRecord } from '../task-runs.js';
import type { ToolCallRecoveryDecision } from '../tool-call-recovery.js';

export type ScheduledTaskEventType =
  | 'task.created'
  | 'task.deduplicated'
  | 'task.running'
  | 'task.cancelled'
  | 'task.succeeded'
  | 'task.failed';

export interface ScheduledTaskEvent {
  type: ScheduledTaskEventType;
  taskRun: TaskRunRecord;
}

export interface ScheduledAgentTaskInput extends AgentConfig {
  prompt: string;
  taskRunId?: string;
  runSpecId?: string;
  traceId?: string;
  dedupeKey?: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  requestId?: string;
  timeoutMs?: number;
  promptPreview?: string;
  metadata?: Record<string, unknown>;
  runContract?: RunContractMetadataInput;
  executor?: ScheduledExecutorConfig;
  onTaskEvent?: (event: ScheduledTaskEvent) => void | Promise<void>;
}

export interface ScheduledExecutorConfig {
  enabled?: boolean;
  nodeUrls?: readonly string[];
  agentKey?: string;
  nodeId?: string;
  leaseMs?: number;
  heartbeatMs?: number;
}

export interface RunAgentTaskGraphSerialInput extends Omit<ScheduledAgentTaskInput, 'prompt' | 'promptPreview' | 'taskRunId' | 'dedupeKey'> {
  graphId: string;
  maxTasks?: number;
  maxParallelTasks?: number;
  editableSurfaceMode?: EditableSurfaceConflictMode;
  requireVerifier?: boolean;
}

export interface RunAgentTaskGraphSerialResult {
  graphId: string;
  executedTasks: Array<{
    taskId: string;
    taskRunId?: string;
    attemptId: string;
    status: AgentTaskAttemptStatus;
    verificationRecordId?: string;
    recoveryFollowUpQueued?: boolean;
  }>;
  completion: AgentTaskGraphCompletion;
  recovery?: ToolCallRecoveryDecision;
}

export type ScheduledAgentTaskResult =
  | {
      status: 'completed';
      sessionId: string;
      taskRun: TaskRunRecord;
      result: AgentResult;
    }
  | {
      status: 'deduplicated';
      sessionId: string;
      taskRun: TaskRunRecord;
    }
  | {
      status: 'cancelled';
      sessionId: string;
      taskRun: TaskRunRecord;
      reason: string;
    };

export type GraphTaskProviderModelTarget = {
  provider?: string;
  model?: string;
};

export type GraphTaskRequiredProviderModelTarget = {
  provider: string;
  model?: string;
};

export type GraphTaskProviderModelSelection = GraphTaskProviderModelTarget & {
  source: 'task_metadata' | 'provider_compat_evidence' | 'graph_task_target' | 'scheduler_input';
  evidenceId?: string;
  targetLabel?: string;
  requireProviderCompat?: boolean;
  rejectedTargetLabels?: string[];
};
