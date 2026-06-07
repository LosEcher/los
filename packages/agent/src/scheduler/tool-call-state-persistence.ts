import type { ToolCallStateTransition } from '../loop.js';
import {
  createToolCallState,
  listToolCallStatesForTaskRun,
  updateToolCallState,
  type ToolCallStateType,
} from '../tool-call-states.js';

export async function persistScheduledToolCallState(input: {
  transition: ToolCallStateTransition;
  sessionId: string;
  runSpecId?: string;
  taskRunId?: string;
}): Promise<void> {
  const { transition, sessionId, runSpecId, taskRunId } = input;
  if (transition.state === 'requested') {
    await createToolCallState({
      id: transition.callId,
      sessionId,
      runSpecId,
      taskRunId,
      turn: transition.turn,
      toolName: transition.toolName,
      state: transition.state,
      inputJson: transition.input,
      maxAttempts: transition.maxAttempts,
      idempotent: transition.idempotent,
      retryPolicy: transition.retryPolicy,
    });
    return;
  }

  const updated = await updateToolCallState(transition.callId, sessionId, {
    state: normalizeToolCallState(transition.state),
    outputSummary: transition.outputSummary,
    error: transition.error ?? null,
    durationMs: transition.durationMs,
    attempt: transition.attempt,
  });
  if (updated) return;

  await createToolCallState({
    id: transition.callId,
    sessionId,
    runSpecId,
    taskRunId,
    turn: transition.turn,
    toolName: transition.toolName,
    state: normalizeToolCallState(transition.state),
    inputJson: transition.input,
    maxAttempts: transition.maxAttempts,
    idempotent: transition.idempotent,
    retryPolicy: transition.retryPolicy,
  });
}

export async function listToolCallStateIdsForTaskRun(taskRunId: string): Promise<string[]> {
  const states = await listToolCallStatesForTaskRun(taskRunId, 1000);
  return states.map(state => state.id);
}

function normalizeToolCallState(state: ToolCallStateTransition['state']): ToolCallStateType {
  return state;
}
