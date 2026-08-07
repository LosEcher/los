/**
 * @los/agent/runtime-task — Shared external-runtime delegation.
 *
 * Single implementation used by both entry points:
 *   - the agent-internal `run_runtime_task` tool (tools/core/registry.ts)
 *   - the gateway operator endpoint POST/GET /v1/runtime-task (runtime-task-routes.ts)
 *
 * Spawns the external CLI (codex / grok) in the gateway process — outside the
 * agent sandbox, so network and credentials work. Approval/authorization is
 * enforced by each caller (tool: L2 approval; route: operator token).
 */

import { spawnCodex } from './runtime-adapter/codex.js';
import { spawnGrok } from './runtime-adapter/grok.js';

export type RuntimeTaskKind = 'codex' | 'grok';

export interface RunExternalRuntimeInput {
  kind: RuntimeTaskKind;
  prompt: string;
  /** Seconds. Default 300, clamped to [30, 1800]. */
  timeoutSec?: number;
  workspaceRoot: string;
  /** Session id used for codex adapter session naming + OTel attributes. */
  sessionId?: string;
  /** Max stdout bytes retained (default 128k). */
  outputLimitBytes?: number;
}

export interface RunExternalRuntimeResult {
  /** Captured stdout (bounded by outputLimitBytes). */
  content: string;
  /** Present when the CLI exited non-zero or spawn failed. */
  error?: string;
  exitCode: number | null;
  spawnFailed: boolean;
  truncated: boolean;
  /** Human-readable description of the runtime, e.g. "codex" / "grok". */
  runtime: RuntimeTaskKind;
}

/** Clamp timeout seconds to the contract bounds [30, 1800]. */
function clampRuntimeTaskTimeoutSec(value: unknown): number {
  const requested = Number(value ?? 300);
  const clamped = Number.isFinite(requested) ? requested : 300;
  return Math.max(30, Math.min(clamped, 1800));
}

/**
 * Delegate a prompt to an external agent runtime CLI and await its stdout.
 * Never throws for CLI failures — errors are returned in the result shape.
 */
export async function runExternalRuntime(input: RunExternalRuntimeInput): Promise<RunExternalRuntimeResult> {
  const timeoutSec = clampRuntimeTaskTimeoutSec(input.timeoutSec);
  const timeoutMs = timeoutSec * 1000;
  const outputLimitBytes = Math.max(4_096, Math.min(512_000, input.outputLimitBytes ?? 128_000));
  const sessionId = input.sessionId ?? `runtime-${input.kind}-${Date.now().toString(36)}`;
  const prompt = input.prompt.trim();
  if (!prompt) {
    return { content: '', error: 'prompt is required', exitCode: null, spawnFailed: false, truncated: false, runtime: input.kind };
  }
  if (input.kind !== 'codex' && input.kind !== 'grok') {
    return { content: '', error: `unsupported runtime kind: ${input.kind} (supported: codex, grok)`, exitCode: null, spawnFailed: false, truncated: false, runtime: input.kind };
  }

  if (input.kind === 'codex') {
    const handle = spawnCodex({
      sessionId,
      workspaceRoot: input.workspaceRoot,
      prompt,
      otelEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://127.0.0.1:4318',
      timeoutMs,
      outputLimitBytes,
    });
    const result = await handle.output;
    return {
      content: result.output,
      error: result.exitCode === 0 ? undefined
        : `codex exited with code ${result.exitCode}${result.spawnFailed ? ' (spawn failed)' : ''}`
          + (result.truncated ? ' (stdout truncated)' : ''),
      exitCode: result.exitCode,
      spawnFailed: result.spawnFailed,
      truncated: result.truncated,
      runtime: 'codex',
    };
  }

  // grok
  const handle = spawnGrok({ workspaceRoot: input.workspaceRoot, prompt, timeoutMs });
  const settled = await handle.settled;
  const text = settled.output.text || (settled.exit.exitCode === 0 ? '(no stdout)' : '(no output)');
  return {
    content: text,
    error: settled.exit.exitCode === 0 ? undefined
      : `grok exited with code ${settled.exit.exitCode}${settled.output.errorCode ? ` (${settled.output.errorCode})` : ''}`,
    exitCode: settled.exit.exitCode,
    spawnFailed: settled.output.errorCode === 'grok_spawn_failed',
    truncated: false,
    runtime: 'grok',
  };
}
