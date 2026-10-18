import type { EditableSurfaceConflictMode } from '../agent-task-editable-surfaces.js';
import type { AgentTaskAttemptStatus, AgentTaskRecord } from '../agent-task-graph.js';
import type { AgentTaskGraphCompletion } from '../agent-task-graph-read-model.js';
import type { AgentConfig, AgentResult } from '../loop.js';
import type { RunContractMetadataInput } from '../run-contract.js';
import type { TaskRunRecord } from '../task-runs.js';
import type { ToolCallRecoveryDecision } from '../tool-call-recovery.js';
import type { PiKernelShadowConfig } from '../pi-kernel-shadow.js';

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
  /** LOS-owned execution-kernel adapter. Defaults to `los`; unknown kinds fail closed. */
  executionKernelKind?: string;
  /** Explicit comparison-only kernel. It cannot affect production output or state. */
  executionKernelShadow?: PiKernelShadowConfig;
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
  /**
   * Goal/stop-condition override for the post-execution self-check gate.
   * Graph workers inherit the parent run spec's contract, whose goal spans the
   * whole graph; without this override the self-check would judge a single
   * worker's output against the parent goal and block it. When set, the
   * self-check uses this contract instead of the persisted run spec contract.
   */
  selfCheckContract?: RunContractMetadataInput;
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
  /** Soft preference: influences candidate ordering, but may fall through. */
  nodeId?: string;
  /**
   * Hard pin: the selected executor must be this node. Missing/offline/
   * non-candidate nodes fail the dispatch instead of falling through to another
   * executor. Use this for operator-placed runs; `nodeId` alone is only a
   * preference and must not be documented as a guarantee.
   */
  requiredNodeId?: string;
  leaseMs?: number;
  heartbeatMs?: number;
  requiresBuild?: boolean;
  requiresDeploy?: boolean;
  requiredCapabilities?: readonly ExecutorCapabilityRequirement[];
  /**
   * S7：`portable` 表示**本任务不依赖工作区文件**（如只读的舰队/节点巡检、纯计算任务），
   * 于是"节点上有没有这个工作区"不再是门槛，只要节点可达就可参与轮转。
   * 不写 = `verify`：必须证明工作区在节点本地存在。
   */
  workspacePolicy?: 'verify' | 'portable';
  /** S7：见 ConfigSchema `executor.placementPolicy`（不写则取全局配置）。 */
  placementPolicy?: 'health' | 'verified-rotate';
}

export type ExecutorCapabilityRequirement =
  | 'workspace_read'
  | 'workspace_write'
  | 'shell'
  | 'sandbox'
  | 'network_egress'
  | 'heavy_task_safe'
  | 'deploy_safe'
  // 2026-10-11：机队本就在上报、且跨设备工作流真正需要的能力，此前**既不可要求、又被静默丢弃**
  // （cantool 的 M3→M1 产物搬运需要 artifact_transfer；远端派发需要 run_agent）。
  | 'run_agent'
  | 'artifact_transfer'
  | 'node_command_runner'
  | 'file_sync_scan'
  | 'file_sync_deep_verify';

/**
 * 可要求能力的**运行时单一清单**（与上面的类型同源）。`satisfiesCapability` 的判定是
 * "节点上报值为 true"（sandbox 例外：需要具体后端字符串），因此这里只列可布尔判定的键。
 */
const EXECUTOR_CAPABILITY_REQUIREMENTS: readonly ExecutorCapabilityRequirement[] = [
  'workspace_read', 'workspace_write', 'shell', 'sandbox', 'network_egress',
  'heavy_task_safe', 'deploy_safe',
  'run_agent', 'artifact_transfer', 'node_command_runner', 'file_sync_scan', 'file_sync_deep_verify',
];

export function listExecutorCapabilityRequirements(): ExecutorCapabilityRequirement[] {
  return [...EXECUTOR_CAPABILITY_REQUIREMENTS];
}

export function isExecutorCapabilityRequirement(value: unknown): value is ExecutorCapabilityRequirement {
  return typeof value === 'string' && (EXECUTOR_CAPABILITY_REQUIREMENTS as readonly string[]).includes(value);
}

export interface ExecutorPlacementIntent {
  toolMode?: 'all' | 'project-write' | 'read-only';
  sandboxMode?: 'readonly' | 'workspace-write' | 'sandbox';
  /**
   * 本任务的工作区（节点本地路径）。S7 起它是**候选资格的一部分**：默认策略下，
   * 只有"这个路径确实在节点本地存在"的节点才算候选——在此之前路由完全不看工作区，
   * 选出来的节点可能根本读不到文件。
   */
  workspaceRoot?: string;
  /** 见 ConfigSchema `executor.workspacePolicy`。 */
  workspacePolicy?: 'verify' | 'portable';
  /** 见 ConfigSchema `executor.placementPolicy`。 */
  placementPolicy?: 'health' | 'verified-rotate';
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
