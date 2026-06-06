import {
  listToolCallStatesForRunSpec,
  listToolCallStatesForTaskRun,
  type ToolCallStateRecord,
} from './tool-call-states.js';

export type ToolCallRecoveryIntent = 'recover' | 'cancel';
export type ToolCallRecoveryRecommendation = 'none' | 'resume' | 'retry' | 'cancel' | 'operator_attention';

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

const ACTIVE_STATES = new Set(['requested', 'approved', 'running', 'retrying']);

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
