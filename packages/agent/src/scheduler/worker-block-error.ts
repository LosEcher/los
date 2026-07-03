/**
 * Worker-initiated block primitive.
 *
 * Built-in worker tools (ask_coordinator / escalate) need to interrupt runAgent
 * mid-loop AND transition the task_run to 'blocked' (not 'cancelled'). runAgent's
 * tool runner turns tool-impl throws into a normal `result.error` tool result and
 * keeps looping, so throwing from the tool does not interrupt. The only clean
 * interrupt surface is the AbortSignal wired through runAgent
 * (loop/utils.ts assertNotAborted).
 *
 * Flow:
 *   1. tool emits worker_message + appendSessionEvent + transitionExecutionState(blocked)
 *   2. tool calls abortTaskRunForBlock(taskRunId, blockReason) (in abort-registry.ts)
 *   3. abort-registry aborts the controller with a `worker_block:<reason>` AbortError
 *   4. runAgent's next assertNotAborted rejects with the abort error
 *   5. scheduled-task-runner's catch sees the worker_block reason (via
 *      getScheduledTaskAbortReason + isWorkerBlockReason) and returns
 *      {status:'blocked'} instead of 'cancelled'
 *
 * The blocked transition in step 1 must happen BEFORE the abort in step 2 — the
 * abort is just to unwind the loop; the state machine change is what makes the
 * task actually blocked.
 *
 * Note: the abort reason is carried as a string (`worker_block:<reason>`) on the
 * AbortError's message, not as a custom Error subclass — this keeps abort-registry's
 * createAbortError(reason: string) signature unchanged and lets the catch branch
 * distinguish block from cancel via a simple prefix check.
 */

const BLOCK_REASON_PREFIX = 'worker_block:';

/** True if an abort reason string was produced by a worker-block abort. */
export function isWorkerBlockReason(reason: string | undefined): boolean {
  return !!reason && reason.startsWith(BLOCK_REASON_PREFIX);
}

/** Extract the block reason (e.g. 'worker_ask') from a worker-block abort reason. */
export function workerBlockReasonFrom(reason: string | undefined): string | undefined {
  if (!reason || !reason.startsWith(BLOCK_REASON_PREFIX)) return undefined;
  return reason.slice(BLOCK_REASON_PREFIX.length);
}

