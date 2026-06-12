/**
 * Lifecycle hook runner — executes shell commands defined in RunContractMetadata.hooks
 * at task lifecycle events. Hook failures emit warning session events but do NOT
 * block the main operation.
 *
 * Pattern inspired by Trellis's config.yaml lifecycle hooks.
 */

import { spawn } from 'node:child_process';
import { appendSessionEvent } from './session-events.js';
import type { TaskLifecycleHooks } from './run-contract.js';

export interface RunHookInput {
  hooks: TaskLifecycleHooks;
  sessionId: string;
  runSpecId?: string;
  taskRunId?: string;
  /** Environment variables to pass to hook scripts */
  env?: Record<string, string | undefined>;
}

export type HookEvent = keyof TaskLifecycleHooks;

/**
 * Run all hooks for a lifecycle event. Each hook runs sequentially.
 * Failures are recorded as session events but do not throw.
 */
export async function runLifecycleHooks(
  event: HookEvent,
  input: RunHookInput,
): Promise<void> {
  const commands = input.hooks[event];
  if (!commands || commands.length === 0) return;

  const hookEnv: Record<string, string | undefined> = {
    ...process.env,
    ...input.env,
    LOS_HOOK_EVENT: event,
    LOS_SESSION_ID: input.sessionId,
    LOS_RUN_SPEC_ID: input.runSpecId ?? '',
    LOS_TASK_RUN_ID: input.taskRunId ?? '',
  };

  for (const command of commands) {
    const started = Date.now();
    try {
      const result = await runHookCommand(command, hookEnv);
      await appendSessionEvent({
        sessionId: input.sessionId,
        type: 'hook.succeeded',
        source: 'los.lifecycle',
        payload: {
          event,
          command,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          runSpecId: input.runSpecId,
          taskRunId: input.taskRunId,
        },
      }).catch(() => undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await appendSessionEvent({
        sessionId: input.sessionId,
        type: 'hook.failed',
        source: 'los.lifecycle',
        payload: {
          event,
          command,
          error: message,
          durationMs: Date.now() - started,
          runSpecId: input.runSpecId,
          taskRunId: input.taskRunId,
        },
      }).catch(() => undefined);
      // Hook failures do not block — continue to next hook
    }
  }
}

async function runHookCommand(
  command: string,
  env: Record<string, string | undefined>,
): Promise<{ exitCode: number | null; durationMs: number }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env },
      timeout: 30_000, // 30s timeout per hook
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => {
      reject(err);
    });
    child.on('close', (exitCode) => {
      const durationMs = Date.now() - started;
      if (exitCode === 0) {
        resolve({ exitCode, durationMs });
      } else {
        reject(new Error(stderr.trim() || `exit code ${exitCode}`));
      }
    });
  });
}
