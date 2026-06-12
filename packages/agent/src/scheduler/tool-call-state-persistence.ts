import type { ToolCallStateTransition } from '../loop.js';
import {
  createToolCallState,
  updateToolCallState,
  type ToolCallStateType,
} from '../tool-call-states.js';
import { transitionExecutionState } from '../execution-store.js';
import { appendSessionEvent } from '../session-events.js';

/**
 * Persist a tool call state transition within a scheduled task run.
 *
 * Creation (state = 'requested') still uses createToolCallState since the row
 * doesn't exist yet. All subsequent state transitions go through
 * transitionExecutionState so the state change, session event, and outbox
 * write are committed atomically.
 *
 * When the state machine rejects a transition (e.g. a simplified executor
 * NDJSON stream skips intermediate approval states), fall back to
 * updateToolCallState which performs a non-validated update. This fallback
 * IS audited — a tool_call_state.fallback_update session event is emitted
 * so the bypass is visible in the event ledger.
 */
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

  await transitionExecutionState({
    entityType: 'tool_call_state',
    entityId: transition.callId,
    to: normalizeToolCallState(transition.state),
    sessionId,
    reason: truncateReason(transition.error ?? transition.outputSummary ?? transition.state),
    turn: transition.turn,
    attempt: transition.attempt,
  }).then(async () => {
    // transitionExecutionState handles state + event + outbox atomically,
    // but doesn't set tool-specific metadata. Apply those fields separately.
    if (transition.outputSummary || transition.error || transition.durationMs !== undefined) {
      await updateToolCallState(transition.callId, sessionId, {
        state: normalizeToolCallState(transition.state),
        outputSummary: transition.outputSummary,
        error: transition.error ?? null,
        durationMs: transition.durationMs,
        attempt: transition.attempt,
      }).catch(() => undefined);
    }
  }).catch(async (err) => {
    // Fall back to non-validated update when the state machine rejects
    // (e.g. executor NDJSON streams may skip intermediate approval states)
    // or when the row doesn't exist yet.
    // Emit an audit event so the bypass is visible in the event ledger.
    const fallbackState = normalizeToolCallState(transition.state);
    await appendSessionEvent({
      sessionId,
      type: 'tool_call_state.fallback_update',
      source: 'los.scheduler',
      payload: {
        callId: transition.callId,
        state: fallbackState,
        reason: err instanceof Error ? err.message : 'transition rejected',
        toolName: transition.toolName,
        runSpecId,
        taskRunId,
      },
    });

    const updated = await updateToolCallState(transition.callId, sessionId, {
      state: fallbackState,
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
    }).catch(() => undefined);
  });
}

export async function listToolCallStateIdsForTaskRun(taskRunId: string): Promise<string[]> {
  const { listToolCallStatesForTaskRun } = await import('../tool-call-states.js');
  const states = await listToolCallStatesForTaskRun(taskRunId, 1000);
  return states.map(state => state.id);
}

function normalizeToolCallState(state: ToolCallStateTransition['state']): ToolCallStateType {
  return state;
}

/** Truncate reason text to prevent storing full tool results in session event payloads.
 *  The full output is already available in tool.result events and tool_call_states table. */
function truncateReason(reason: string): string {
  if (reason.length <= 200) return reason;
  return reason.slice(0, 200) + '…';
}
