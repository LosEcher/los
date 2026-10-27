import { loadRunSpec, type RunSpecRecord, type RunSpecStatus } from './run-specs.js';
import { listTaskRunsForRunSpec, type TaskRunRecord, type TaskRunStatus } from './task-runs.js';
import { readToolCallRecoveryForRunSpec, type ToolCallRecoveryDecision } from './tool-call-recovery.js';
import { listVerificationRecordsForRunSpec, type VerificationRecord, type VerificationRecordStatus } from './verification-records.js';
import { resolveVerificationCompletionDecision } from './verification-runner.js';

export type RunStateAction =
  | 'none'
  | 'wait_for_task'
  | 'recover_tools'
  | 'cancel_tools'
  | 'run_verification'
  | 'inspect_events'
  | 'operator_attention';

export type RunStateBlockerKind =
  | 'tool_recovery'
  | 'verification'
  | 'active_task'
  | 'failed_task'
  | 'failed_run'
  | 'blocked_run';

export interface RunStateBlocker {
  kind: RunStateBlockerKind;
  message: string;
  ids: string[];
}

export interface RunStateProjection {
  runSpecId: string;
  sessionId: string;
  phase: RunSpecStatus;
  action: RunStateAction;
  summary: string;
  blockers: RunStateBlocker[];
  counts: {
    taskRuns: Record<TaskRunStatus, number> & { total: number };
    verificationRecords: Record<VerificationRecordStatus, number> & { total: number };
  };
  ids: {
    activeTaskRunIds: string[];
    failedTaskRunIds: string[];
    requiredVerificationRecordIds: string[];
    failedVerificationRecordIds: string[];
    pendingVerificationRecordIds: string[];
  };
  recovery: ToolCallRecoveryDecision;
  /**
   * 落点事实（**观测面**）。
   *
   * 为什么放进 state：证据图（B 层）此前只有 run_spec/task_run/agent_task/attempt 的结构关系，
   * 没有任何"这次实际落在哪台机器、用了哪家模型、工作区在哪"的字段 ⇒ 图上无法回答
   * "这个 run 跑在哪"，也就无法与机队（A 层）对齐。
   *
   * 口径与边界（三条都是刻意的）：
   *   · 取自 `task_runs`（**观测**），不是 `run_specs.node_id`（声明面，且该列结构上不可达：
   *     放置路径不建 run_spec，实测 711/711 为 NULL）；
   *   · 值**原样保留**、不做归一化：`gateway-local`（网关进程内执行）与未登记 id 都照实出现，
   *     否则"字段被当成两种东西用"这个症状会被抹掉；
   *   · 缺失**不补默认值**：没有落点的 task run 只体现在 `taskRunsWithoutNode` 的计数里。
   */
  placement: {
    /** 去重后的落点 node id（稳定升序，便于断言与比对）。 */
    nodeIds: string[];
    providers: string[];
    models: string[];
    workspaceRoots: string[];
    /** 观测面缺失的条数（>0 表示有 task run 没有记录落点——如实暴露，不猜）。 */
    taskRunsWithoutNode: number;
  };
}

export interface BuildRunStateProjectionInput {
  runSpec: RunSpecRecord;
  taskRuns: readonly TaskRunRecord[];
  verificationRecords: readonly VerificationRecord[];
  recovery: ToolCallRecoveryDecision;
}

export async function readRunStateProjection(runSpecId: string): Promise<RunStateProjection | null> {
  const runSpec = await loadRunSpec(runSpecId);
  if (!runSpec) return null;
  const [taskRuns, verificationRecords, recovery] = await Promise.all([
    listTaskRunsForRunSpec(runSpec.id),
    listVerificationRecordsForRunSpec(runSpec.id),
    readToolCallRecoveryForRunSpec(runSpec.id),
  ]);
  return buildRunStateProjection({
    runSpec,
    taskRuns,
    verificationRecords,
    recovery,
  });
}

function uniqueSorted(values: readonly (string | undefined | null)[]): string[] {
  return [...new Set(values.map(value => (typeof value === 'string' ? value.trim() : '')).filter(Boolean))].sort();
}

export function buildRunStateProjection(input: BuildRunStateProjectionInput): RunStateProjection {
  const verificationDecision = resolveVerificationCompletionDecision(input.verificationRecords);
  const activeTaskRunIds = input.taskRuns
    .filter(task => task.status === 'queued' || task.status === 'running')
    .map(task => task.id);
  const failedTaskRunIds = input.taskRuns
    .filter(task => task.status === 'failed')
    .map(task => task.id);
  const requiredVerificationRecordIds = input.verificationRecords
    .filter(record => record.required)
    .map(record => record.id);

  const blockers: RunStateBlocker[] = [];
  if (input.recovery.status === 'action_required') {
    blockers.push({
      kind: 'tool_recovery',
      message: `tool recovery recommendation is ${input.recovery.recommendation}`,
      ids: [
        ...input.recovery.resumeToolCallIds,
        ...input.recovery.retryToolCallIds,
        ...input.recovery.cancelToolCallIds,
        ...input.recovery.operatorAttentionToolCallIds,
      ],
    });
  }
  if (verificationDecision.blockedVerificationRecordIds.length > 0) {
    blockers.push({
      kind: 'verification',
      message: 'required verification records are not satisfied',
      ids: verificationDecision.blockedVerificationRecordIds,
    });
  }
  if (activeTaskRunIds.length > 0) {
    blockers.push({
      kind: 'active_task',
      message: 'task runs are still queued or running',
      ids: activeTaskRunIds,
    });
  }
  if (failedTaskRunIds.length > 0 && input.runSpec.status !== 'succeeded') {
    blockers.push({
      kind: 'failed_task',
      message: 'one or more task runs failed',
      ids: failedTaskRunIds,
    });
  }
  if (input.runSpec.status === 'failed') {
    blockers.push({
      kind: 'failed_run',
      message: 'run spec is failed',
      ids: [input.runSpec.id],
    });
  }
  if (input.runSpec.status === 'blocked' && blockers.length === 0) {
    blockers.push({
      kind: 'blocked_run',
      message: 'run spec is blocked without a classified recovery reason',
      ids: [input.runSpec.id],
    });
  }

  const action = chooseRunStateAction({
    runSpec: input.runSpec,
    activeTaskRunIds,
    verificationDecision,
    recovery: input.recovery,
    blockers,
  });

  return {
    placement: {
      nodeIds: uniqueSorted(input.taskRuns.map(task => task.nodeId)),
      providers: uniqueSorted(input.taskRuns.map(task => task.provider)),
      models: uniqueSorted(input.taskRuns.map(task => task.model)),
      workspaceRoots: uniqueSorted(input.taskRuns.map(task => task.workspaceRoot)),
      taskRunsWithoutNode: input.taskRuns.filter(task => !task.nodeId).length,
    },
    runSpecId: input.runSpec.id,
    sessionId: input.runSpec.sessionId,
    phase: input.runSpec.status,
    action,
    summary: summarizeRunState(input.runSpec.status, action, blockers.length),
    blockers,
    counts: {
      taskRuns: countTaskRuns(input.taskRuns),
      verificationRecords: countVerificationRecords(input.verificationRecords),
    },
    ids: {
      activeTaskRunIds,
      failedTaskRunIds,
      requiredVerificationRecordIds,
      failedVerificationRecordIds: verificationDecision.failedVerificationRecordIds,
      pendingVerificationRecordIds: verificationDecision.pendingVerificationRecordIds,
    },
    recovery: input.recovery,
  };
}

function chooseRunStateAction(input: {
  runSpec: RunSpecRecord;
  activeTaskRunIds: readonly string[];
  verificationDecision: ReturnType<typeof resolveVerificationCompletionDecision>;
  recovery: ToolCallRecoveryDecision;
  blockers: readonly RunStateBlocker[];
}): RunStateAction {
  if (input.recovery.recommendation === 'operator_attention') return 'operator_attention';
  if (input.recovery.recommendation === 'cancel') return 'cancel_tools';
  if (input.recovery.recommendation === 'resume' || input.recovery.recommendation === 'retry') return 'recover_tools';
  if (input.verificationDecision.blockedVerificationRecordIds.length > 0) return 'run_verification';
  if (input.activeTaskRunIds.length > 0 || input.runSpec.status === 'created' || input.runSpec.status === 'running') return 'wait_for_task';
  if (input.runSpec.status === 'failed') return 'inspect_events';
  if (input.runSpec.status === 'blocked' && input.blockers.length > 0) return 'operator_attention';
  return 'none';
}

function summarizeRunState(phase: RunSpecStatus, action: RunStateAction, blockerCount: number): string {
  if (action === 'none') return `run is ${phase}`;
  return `run is ${phase}; next action ${action}; blockers=${blockerCount}`;
}

function countTaskRuns(taskRuns: readonly TaskRunRecord[]): Record<TaskRunStatus, number> & { total: number } {
  return {
    total: taskRuns.length,
    queued: taskRuns.filter(task => task.status === 'queued').length,
    running: taskRuns.filter(task => task.status === 'running').length,
    succeeded: taskRuns.filter(task => task.status === 'succeeded').length,
    failed: taskRuns.filter(task => task.status === 'failed').length,
    cancelled: taskRuns.filter(task => task.status === 'cancelled').length,
    blocked: taskRuns.filter(task => task.status === 'blocked').length,
  };
}

function countVerificationRecords(records: readonly VerificationRecord[]): Record<VerificationRecordStatus, number> & { total: number } {
  return {
    total: records.length,
    required: records.filter(record => record.status === 'required').length,
    running: records.filter(record => record.status === 'running').length,
    succeeded: records.filter(record => record.status === 'succeeded').length,
    failed: records.filter(record => record.status === 'failed').length,
    skipped: records.filter(record => record.status === 'skipped').length,
  };
}
