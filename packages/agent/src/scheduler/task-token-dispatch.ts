import { getConfig } from '@los/infra/config';
import { mintTaskToken } from '@los/infra/task-token';

/**
 * Resolve the task token that rides in the dispatch envelope.
 *
 * `required` is deliberately fail-loud: a deployment that says "no DB
 * fallback" must not silently dispatch without a token. `auto` keeps the
 * legacy path for local executors while allowing remote nodes to migrate.
 * The token is never placed in `input.config` or in the prompt.
 */
export function _resolveDispatchTaskToken(input: {
  taskRunId: string;
  leaseVersion: number;
  taskToken?: string;
}): string | undefined {
  if (input.taskToken) return input.taskToken;

  let config: ReturnType<typeof getConfig>;
  try {
    config = getConfig();
  } catch {
    // Scheduler unit tests may exercise body construction without a loaded
    // config. The production scheduler always has one.
    return undefined;
  }

  const mode = config.executor.taskTokenMode ?? 'auto';
  if (mode === 'off') return undefined;
  const secret = config.executor.taskTokenSecret;
  if (!secret) {
    if (mode === 'required') {
      throw new Error('task token is required but LOS_TASK_TOKEN_SECRET is not configured');
    }
    return undefined;
  }
  return mintTaskToken({
    taskRunId: input.taskRunId,
    leaseVersion: input.leaseVersion,
    secret,
  }).token;
}
