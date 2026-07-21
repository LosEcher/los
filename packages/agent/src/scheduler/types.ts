import type { EditableSurfaceConflictMode } from '../agent-task-editable-surfaces.js';
import type { AgentTaskAttemptStatus, AgentTaskRecord } from '../agent-task-graph.js';
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
  | 'task.failed'
  | 'task.blocked'
  | 'task.self_check_completed'
  | 'task.review_completed'
  | 'session.reflection';

export interface ScheduledTaskEvent {
  type: ScheduledTaskEventType;
  taskRun: TaskRunRecord;
}

export interface ScheduledAgentTaskInput extends AgentConfig {
  prompt: string;
  disposition?: 'planning' | 'execution';
  taskRunId?: string;
  /** Attempt number when this task is a retry of an earlier task_run. */
  attempt?: number;
  /** Monotonic task_runs fencing token. Graph runs inherit the agent-task version. */
  leaseVersion?: number;
  agentTaskLease?: {
    taskId: string;
    leaseVersion: number;
  };
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
  verificationOwner?: 'task' | 'graph';
  executor?: ScheduledExecutorConfig;
  onTaskEvent?: (event: ScheduledTaskEvent) => void | Promise<void>;
  /** Context fill monitor — same shape as AgentConfig.contextMonitor */
  contextMonitor?: AgentConfig['contextMonitor'];
}

export interface ScheduledExecutorConfig {
  enabled?: boolean;
  nodeUrls?: readonly string[];
  agentKey?: string;
  nodeId?: string;
  leaseMs?: number;
  heartbeatMs?: number;
  requiresBuild?: boolean;
  requiresDeploy?: boolean;
  requiredCapabilities?: readonly ExecutorCapabilityRequirement[];
}

export type ExecutorCapabilityRequirement =
  | 'workspace_read'
  | 'workspace_write'
  | 'shell'
  | 'sandbox'
  | 'network_egress'
  | 'heavy_task_safe'
  | 'deploy_safe';

export interface ExecutorPlacementIntent {
  toolMode?: 'all' | 'project-write' | 'read-only';
  sandboxMode?: 'readonly' | 'workspace-write' | 'sandbox';
}

export interface RunAgentTaskGraphSerialInput extends Omit<ScheduledAgentTaskInput, 'prompt' | 'promptPreview' | 'taskRunId' | 'dedupeKey'> {
  graphId: string;
  maxTasks?: number;
  maxParallelTasks?: number;
  editableSurfaceMode?: EditableSurfaceConflictMode;
  requireVerifier?: boolean;
  resolveTaskPrompt?: (
    task: AgentTaskRecord,
    completedStages: readonly AgentTaskGraphStageOutput[],
  ) => string | Promise<string>;
}

export interface AgentTaskGraphStageOutput {
  taskId: string;
  title: string;
  outputText: string;
  provider?: string;
  model?: string;
  promptTokens: number;
  completionTokens: number;
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
    stageOutput?: AgentTaskGraphStageOutput;
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
      status: 'awaiting_approval';
      sessionId: string;
      taskRun: TaskRunRecord;
      result: AgentResult;
      planRevision: number;
      planStepCount: number;
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
    }
  | {
      status: 'blocked';
      sessionId: string;
      taskRun: TaskRunRecord;
      /** Present when blocked after runAgent returned (e.g. verification gate).
       *  Absent when the worker blocked mid-execution via ask_coordinator/escalate
       *  (runAgent was aborted, no result was produced). */
      result?: AgentResult;
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
