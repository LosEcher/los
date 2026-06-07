import {
  listToolCallStatesForRunSpec,
  listToolCallStatesForTaskRun,
  updateToolCallState,
  type ToolCallStateRecord,
} from './tool-call-states.js';
import { appendSessionEvent } from './session-events.js';
import { listTaskRunsForRunSpec, updateTaskRun } from './task-runs.js';
import { loadRunSpec, updateRunSpecStatus, type RunSpecRecord } from './run-specs.js';

export type ToolCallRecoveryIntent = 'recover' | 'cancel';
export type ToolCallRecoveryRecommendation = 'none' | 'resume' | 'retry' | 'cancel' | 'operator_attention';
export type ToolCallRecoveryTransitionAction = 'cancel' | 'operator_attention';

export interface ToolCallRecoveryOptions {
  intent?: ToolCallRecoveryIntent;
  staleMs?: number;
  now?: Date | string;
}

export interface ToolCallRecoveryDecision {
  status: 'clean' | 'action_required';
  recommendation: ToolCallRecoveryRecommendation;
  retryToolCallIds: string[];
  resumeToolCallIds: string[];
  cancelToolCallIds: string[];
  operatorAttentionToolCallIds: string[];
  terminalFailedToolCallIds: string[];
  activeToolCallIds: string[];
  reasons: string[];
}

export interface ApplyToolCallRecoveryTransitionOptions extends ToolCallRecoveryOptions {
  action: ToolCallRecoveryTransitionAction;
  reason?: string;
  actor?: string;
  cancelLiveTaskRun?: (taskRunId: string, reason: string) => boolean;
}

export interface ToolCallRecoveryTransitionResult {
  runSpecId: string;
  sessionId: string;
  action: ToolCallRecoveryTransitionAction;
  runSpecStatus: 'blocked' | 'cancelled';
  decision: ToolCallRecoveryDecision;
  transitionedToolCallIds: string[];
  transitionedTaskRunIds: string[];
  liveCancelledTaskRunIds: string[];
  eventType: 'run.recovery_cancelled' | 'run.operator_attention_required';
  reason: string;
}

const ACTIVE_STATES = new Set(['requested', 'approved', 'running', 'retrying']);
const ACTIVE_TASK_RUN_STATUSES = new Set(['queued', 'running']);

export function evaluateToolCallRecovery(
  toolStates: readonly ToolCallStateRecord[],
  options: ToolCallRecoveryOptions = {},
): ToolCallRecoveryDecision {
  const intent = options.intent ?? 'recover';
  const staleMs = normalizeNonNegativeInteger(options.staleMs) ?? 300_000;
  const nowMs = toTimeMs(options.now ?? new Date());
  const retryToolCallIds: string[] = [];
  const resumeToolCallIds: string[] = [];
  const cancelToolCallIds: string[] = [];
  const operatorAttentionToolCallIds: string[] = [];
  const terminalFailedToolCallIds: string[] = [];
  const activeToolCallIds: string[] = [];
  const reasons: string[] = [];

  for (const state of toolStates) {
    if (ACTIVE_STATES.has(state.state)) {
      activeToolCallIds.push(state.id);
      if (intent === 'cancel') {
        cancelToolCallIds.push(state.id);
        reasons.push(`${state.id}: active ${state.state} should be cancelled`);
      } else if (isStale(state, nowMs, staleMs)) {
        resumeToolCallIds.push(state.id);
        reasons.push(`${state.id}: active ${state.state} is stale and resumable`);
      }
      continue;
    }

    if (state.state === 'failed') {
      terminalFailedToolCallIds.push(state.id);
      if (state.idempotent && state.attempt < state.maxAttempts) {
        retryToolCallIds.push(state.id);
        reasons.push(`${state.id}: failed idempotent tool can retry attempt ${state.attempt + 1}/${state.maxAttempts}`);
      } else {
        operatorAttentionToolCallIds.push(state.id);
        reasons.push(`${state.id}: failed tool is not automatically retryable`);
      }
      continue;
    }

    if (state.state === 'denied') {
      operatorAttentionToolCallIds.push(state.id);
      reasons.push(`${state.id}: denied tool call requires operator action`);
    }
  }

  const recommendation = chooseRecommendation({
    cancelToolCallIds,
    operatorAttentionToolCallIds,
    retryToolCallIds,
    resumeToolCallIds,
  });
  return {
    status: recommendation === 'none' ? 'clean' : 'action_required',
    recommendation,
    retryToolCallIds,
    resumeToolCallIds,
    cancelToolCallIds,
    operatorAttentionToolCallIds,
    terminalFailedToolCallIds,
    activeToolCallIds,
    reasons,
  };
}

export async function readToolCallRecoveryForRunSpec(
  runSpecId: string,
  options: ToolCallRecoveryOptions = {},
): Promise<ToolCallRecoveryDecision> {
  const records = await listToolCallStatesForRunSpec(runSpecId);
  return evaluateToolCallRecovery(records, options);
}

export async function readToolCallRecoveryForTaskRun(
  taskRunId: string,
  options: ToolCallRecoveryOptions = {},
): Promise<ToolCallRecoveryDecision> {
  const records = await listToolCallStatesForTaskRun(taskRunId);
  return evaluateToolCallRecovery(records, options);
}

export async function applyToolCallRecoveryTransitionForRunSpec(
  runSpecId: string,
  options: ApplyToolCallRecoveryTransitionOptions,
): Promise<ToolCallRecoveryTransitionResult> {
  const runSpec = await loadRunSpec(runSpecId);
  if (!runSpec) throw new Error(`Run spec not found: ${runSpecId}`);

  const decision = await readToolCallRecoveryForRunSpec(runSpecId, {
    intent: options.action === 'cancel' ? 'cancel' : 'recover',
    staleMs: options.staleMs,
    now: options.now,
  });
  const reason = normalizeReason(options.reason) ?? defaultTransitionReason(options.action, decision);

  if (options.action === 'cancel') {
    return await applyCancelTransition(runSpec, decision, reason, options);
  }
  return await applyOperatorAttentionTransition(runSpec, decision, reason, options.actor);
}

function chooseRecommendation(input: {
  retryToolCallIds: string[];
  resumeToolCallIds: string[];
  cancelToolCallIds: string[];
  operatorAttentionToolCallIds: string[];
}): ToolCallRecoveryRecommendation {
  if (input.cancelToolCallIds.length > 0) return 'cancel';
  if (input.operatorAttentionToolCallIds.length > 0) return 'operator_attention';
  if (input.retryToolCallIds.length > 0) return 'retry';
  if (input.resumeToolCallIds.length > 0) return 'resume';
  return 'none';
}

async function applyCancelTransition(
  runSpec: RunSpecRecord,
  decision: ToolCallRecoveryDecision,
  reason: string,
  options: ApplyToolCallRecoveryTransitionOptions,
): Promise<ToolCallRecoveryTransitionResult> {
  const toolStates = await listToolCallStatesForRunSpec(runSpec.id);
  const cancelIds = new Set(decision.cancelToolCallIds);

  const toolUpdates = toolStates
    .filter(state => cancelIds.has(state.id))
    .map(state =>
      updateToolCallState(state.id, state.sessionId, {
        state: 'skipped',
        outputSummary: reason,
        error: null,
      }),
    );
  const results = await Promise.all(toolUpdates);
  const transitionedToolCallIds = results
    .filter((r): r is NonNullable<typeof r> => Boolean(r))
    .map(r => r.id);

  const taskRuns = await listTaskRunsForRunSpec(runSpec.id);
  const activeTaskRuns = taskRuns.filter(taskRun => ACTIVE_TASK_RUN_STATUSES.has(taskRun.status));
  const liveCancelledTaskRunIds: string[] = [];
  for (const taskRun of activeTaskRuns) {
    if (options.cancelLiveTaskRun?.(taskRun.id, reason) === true) {
      liveCancelledTaskRunIds.push(taskRun.id);
    }
  }

  const taskUpdates = activeTaskRuns.map(taskRun =>
    updateTaskRun(taskRun.id, {
      status: 'cancelled',
      metadata: {
        ...taskRun.metadata,
        recoveryAction: 'cancel',
        cancelReason: reason,
      },
    }),
  );
  const taskResults = await Promise.all(taskUpdates);
  const transitionedTaskRunIds = taskResults
    .filter((r): r is NonNullable<typeof r> => Boolean(r))
    .map(r => r.id);

  await updateRunSpecStatus(runSpec.id, 'cancelled');
  await appendRecoveryTransitionEvent(runSpec, 'run.recovery_cancelled', {
    action: 'cancel',
    reason,
    actor: normalizeReason(options.actor),
    decision,
    transitionedToolCallIds,
    transitionedTaskRunIds,
    liveCancelledTaskRunIds,
  });

  return {
    runSpecId: runSpec.id,
    sessionId: runSpec.sessionId,
    action: 'cancel',
    runSpecStatus: 'cancelled',
    decision,
    transitionedToolCallIds,
    transitionedTaskRunIds,
    liveCancelledTaskRunIds,
    eventType: 'run.recovery_cancelled',
    reason,
  };
}

async function applyOperatorAttentionTransition(
  runSpec: RunSpecRecord,
  decision: ToolCallRecoveryDecision,
  reason: string,
  actor?: string,
): Promise<ToolCallRecoveryTransitionResult> {
  await updateRunSpecStatus(runSpec.id, 'blocked');
  await appendRecoveryTransitionEvent(runSpec, 'run.operator_attention_required', {
    action: 'operator_attention',
    reason,
    actor: normalizeReason(actor),
    decision,
  });

  return {
    runSpecId: runSpec.id,
    sessionId: runSpec.sessionId,
    action: 'operator_attention',
    runSpecStatus: 'blocked',
    decision,
    transitionedToolCallIds: [],
    transitionedTaskRunIds: [],
    liveCancelledTaskRunIds: [],
    eventType: 'run.operator_attention_required',
    reason,
  };
}

async function appendRecoveryTransitionEvent(
  runSpec: RunSpecRecord,
  type: ToolCallRecoveryTransitionResult['eventType'],
  payload: Record<string, unknown>,
): Promise<void> {
  await appendSessionEvent({
    sessionId: runSpec.sessionId,
    tenantId: runSpec.tenantId,
    projectId: runSpec.projectId,
    userId: runSpec.userId,
    nodeId: runSpec.nodeId,
    requestId: runSpec.requestId,
    traceId: runSpec.traceId,
    type,
    payload: {
      runSpecId: runSpec.id,
      ...payload,
    },
  });
}

function defaultTransitionReason(
  action: ToolCallRecoveryTransitionAction,
  decision: ToolCallRecoveryDecision,
): string {
  if (action === 'cancel') return 'recovery_cancel_requested';
  return decision.reasons[0] ?? 'operator_attention_requested';
}

function isStale(record: ToolCallStateRecord, nowMs: number, staleMs: number): boolean {
  return nowMs - toTimeMs(record.updatedAt) >= staleMs;
}

function toTimeMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function normalizeNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const rounded = Math.floor(value);
  return rounded >= 0 ? rounded : undefined;
}

function normalizeReason(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
