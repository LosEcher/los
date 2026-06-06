import type { RunSpecStatus } from './run-specs.js';
import type { TaskRunStatus } from './task-runs.js';
import type { ToolCallStateType } from './tool-call-states.js';
import type { VerificationRecordStatus } from './verification-records.js';

export type ExecutionEntityType =
  | 'run_spec'
  | 'task_run'
  | 'tool_call_state'
  | 'verification_record';

export type ExecutionStateByEntity = {
  run_spec: RunSpecStatus;
  task_run: TaskRunStatus;
  tool_call_state: ToolCallStateType;
  verification_record: VerificationRecordStatus;
};

export type ExecutionState = ExecutionStateByEntity[ExecutionEntityType];

export interface ExecutionTransitionInput<T extends ExecutionEntityType = ExecutionEntityType> {
  entityType: T;
  from: ExecutionStateByEntity[T];
  to: ExecutionStateByEntity[T];
}

export interface ExecutionTransitionResult {
  allowed: boolean;
  reason: string;
}

const RUN_SPEC_TRANSITIONS = {
  created: ['running', 'cancelled'],
  running: ['succeeded', 'failed', 'cancelled', 'blocked'],
  blocked: ['running', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
} satisfies Record<RunSpecStatus, RunSpecStatus[]>;

const TASK_RUN_TRANSITIONS = {
  queued: ['running', 'cancelled'],
  running: ['succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
} satisfies Record<TaskRunStatus, TaskRunStatus[]>;

const TOOL_CALL_STATE_TRANSITIONS = {
  requested: ['approved', 'denied', 'running', 'skipped'],
  approved: ['running', 'denied', 'skipped'],
  running: ['succeeded', 'failed', 'retrying', 'skipped'],
  retrying: ['running', 'failed', 'skipped'],
  succeeded: [],
  failed: ['retrying'],
  denied: [],
  skipped: [],
} satisfies Record<ToolCallStateType, ToolCallStateType[]>;

const VERIFICATION_RECORD_TRANSITIONS = {
  required: ['running', 'skipped'],
  running: ['succeeded', 'failed', 'skipped'],
  failed: ['running', 'skipped'],
  succeeded: [],
  skipped: [],
} satisfies Record<VerificationRecordStatus, VerificationRecordStatus[]>;

const TERMINAL_STATES = {
  run_spec: ['succeeded', 'failed', 'cancelled'],
  task_run: ['succeeded', 'failed', 'cancelled'],
  tool_call_state: ['succeeded', 'denied', 'skipped'],
  verification_record: ['succeeded', 'skipped'],
} satisfies {
  [K in ExecutionEntityType]: ExecutionStateByEntity[K][];
};

export function evaluateExecutionTransition<T extends ExecutionEntityType>(
  input: ExecutionTransitionInput<T>,
): ExecutionTransitionResult {
  if (input.from === input.to) {
    return { allowed: true, reason: 'idempotent_transition' };
  }
  const allowedTargets = transitionTargets(input.entityType, input.from);
  if (allowedTargets.includes(input.to)) {
    return { allowed: true, reason: 'allowed_transition' };
  }
  if (isTerminalExecutionState(input.entityType, input.from)) {
    return {
      allowed: false,
      reason: `terminal_state:${input.entityType}:${input.from}`,
    };
  }
  return {
    allowed: false,
    reason: `invalid_transition:${input.entityType}:${input.from}->${input.to}`,
  };
}

export function canTransitionExecutionState<T extends ExecutionEntityType>(
  entityType: T,
  from: ExecutionStateByEntity[T],
  to: ExecutionStateByEntity[T],
): boolean {
  return evaluateExecutionTransition({ entityType, from, to }).allowed;
}

export function assertExecutionTransition<T extends ExecutionEntityType>(
  input: ExecutionTransitionInput<T>,
): void {
  const result = evaluateExecutionTransition(input);
  if (!result.allowed) {
    throw new ExecutionTransitionError(input, result.reason);
  }
}

export function isTerminalExecutionState<T extends ExecutionEntityType>(
  entityType: T,
  state: ExecutionStateByEntity[T],
): boolean {
  return (TERMINAL_STATES[entityType] as readonly ExecutionState[]).includes(state);
}

export function executionTransitionEventType<T extends ExecutionEntityType>(
  entityType: T,
  to: ExecutionStateByEntity[T],
): string {
  return `${entityType}.${String(to).replaceAll('_', '-')}`;
}

export class ExecutionTransitionError extends Error {
  constructor(input: ExecutionTransitionInput, reason: string) {
    super(`Invalid execution transition ${input.entityType}: ${input.from} -> ${input.to} (${reason})`);
    this.name = 'ExecutionTransitionError';
  }
}

function transitionTargets<T extends ExecutionEntityType>(
  entityType: T,
  from: ExecutionStateByEntity[T],
): ExecutionStateByEntity[T][] {
  switch (entityType) {
    case 'run_spec':
      return RUN_SPEC_TRANSITIONS[from as RunSpecStatus] as ExecutionStateByEntity[T][];
    case 'task_run':
      return TASK_RUN_TRANSITIONS[from as TaskRunStatus] as ExecutionStateByEntity[T][];
    case 'tool_call_state':
      return TOOL_CALL_STATE_TRANSITIONS[from as ToolCallStateType] as ExecutionStateByEntity[T][];
    case 'verification_record':
      return VERIFICATION_RECORD_TRANSITIONS[from as VerificationRecordStatus] as ExecutionStateByEntity[T][];
  }
}
