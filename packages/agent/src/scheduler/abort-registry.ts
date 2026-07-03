type RunningTaskController = {
  controller: AbortController;
  reason: string;
};

const runningTaskControllers = new Map<string, RunningTaskController>();

export function registerScheduledTaskController(
  taskRunId: string,
  controller: AbortController,
  reason = 'cancelled',
): () => void {
  runningTaskControllers.set(taskRunId, { controller, reason });
  return () => runningTaskControllers.delete(taskRunId);
}

export function getScheduledTaskAbortReason(taskRunId: string): string | undefined {
  return runningTaskControllers.get(taskRunId)?.reason;
}

export function cancelScheduledTask(taskRunId: string, reason = 'cancelled'): boolean {
  const running = runningTaskControllers.get(taskRunId);
  if (!running) return false;
  running.reason = reason;
  if (!running.controller.signal.aborted) {
    running.controller.abort(createAbortError(reason));
  }
  return true;
}

/**
 * Abort a scheduled task because a worker tool asked to block (ask_coordinator /
 * escalate). The `reason` string is stored as the controller's abort reason so
 * scheduled-task-runner's catch can later distinguish a worker block from a real
 * cancellation (see isWorkerBlockReason). The AbortError carried on the signal is
 * tagged with the same reason so it surfaces through runAgent's assertNotAborted.
 */
export function abortTaskRunForBlock(taskRunId: string, blockReason: string): boolean {
  const running = runningTaskControllers.get(taskRunId);
  if (!running) return false;
  running.reason = `worker_block:${blockReason}`;
  if (!running.controller.signal.aborted) {
    running.controller.abort(createAbortError(`worker_block:${blockReason}`));
  }
  return true;
}

export function linkAbortSignal(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => undefined;
  if (source.aborted) {
    target.abort(source.reason);
    return () => undefined;
  }

  const onAbort = () => target.abort(source.reason);
  source.addEventListener('abort', onAbort, { once: true });
  return () => source.removeEventListener('abort', onAbort);
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function createAbortError(reason: string): Error {
  const err = new Error(reason);
  err.name = 'AbortError';
  return err;
}
