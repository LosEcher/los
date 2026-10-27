/**
 * The agent execution channel used by the broker's approval gate.
 *
 * A gateway-dispatched executor task has no interactive approval channel. When
 * the executor is stateless (`EXECUTOR_DB_MODE=none`) this is forced to
 * `stateless`, which makes `needsApproval` tools fail closed. Kept as a tiny
 * pure seam so the mapping is testable without booting the HTTP server.
 */
export type ExecutorExecutionMode = 'interactive' | 'stateless';

export function executionModeForExecutor(stateless: boolean): ExecutorExecutionMode {
  return stateless ? 'stateless' : 'interactive';
}
