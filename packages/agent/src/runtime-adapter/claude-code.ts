/**
 * @los/agent/runtime-adapter/claude-code — Claude Code runtime adapter.
 *
 * Spawns the Claude Code CLI as a child process, configured to emit
 * OTel telemetry to the los OTel bridge. The bridge maps spans to
 * session_events — no stdout parsing needed.
 *
 * Requires Claude Code >= 1.0.0 with CLAUDE_CODE_ENABLE_TELEMETRY support.
 * Falls back to --debug stdout parsing for older versions.
 */

import { spawn, type ChildProcess, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { getLogger } from '@los/infra/logger';
import { redactExternalSummaryText } from '../external-tool-summary.js';
import type { RuntimeAdapterConfig, RuntimeHandle } from './types.js';
import { resolveRuntimeCommand } from './command.js';

const log = getLogger('claude-code-adapter');

export interface ClaudeCodeSpawnInput extends RuntimeAdapterConfig {
  kind: 'claude-code';
  /** The prompt / task description */
  prompt: string;
  /** OTel bridge URL where Claude Code sends telemetry */
  otelEndpoint: string;
  /** Claude Code CLI path (default: 'claude') */
  claudePath?: string;
  /** Additional CLI args */
  extraArgs?: string[];
  /** Max stdout bytes retained for callers (default 128k, clamp [4k, 512k]). */
  outputLimitBytes?: number;
}

export interface ClaudeCodeRuntimeOutput {
  text: string;
  capturedBytes: number;
  totalBytes: number;
  stderrBytes: number;
  truncated: boolean;
  spawnFailed: boolean;
}

export interface ClaudeCodeRuntimeHandle extends RuntimeHandle {
  output: Promise<ClaudeCodeRuntimeOutput>;
}

/**
 * Check if claude CLI supports OTel natively.
 * Returns true if 'claude --version' succeeds and version >= 1.0.
 */
export function claudeCodeSupportsOtel(claudePath = 'claude'): boolean {
  try {
    const out = execFileSync(resolveRuntimeCommand(claudePath), ['--version'], { encoding: 'utf-8', timeout: 5_000 }).trim();
    // Claude Code version format: "Claude Code v1.x.x" or just "1.x.x"
    const versionMatch = out.match(/(\d+)\.(\d+)/);
    if (!versionMatch) return false;
    const major = Number(versionMatch[1]);
    return major >= 1;
  } catch {
    return false;
  }
}

export function claudeCodeAvailable(claudePath = 'claude'): boolean {
  try {
    execFileSync(resolveRuntimeCommand(claudePath), ['--version'], { encoding: 'utf-8', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn Claude Code as a child process, piping its OTel output to the bridge.
 *
 * Claude Code runs in the given workspaceRoot. All telemetry flows to otelEndpoint.
 * The adapter does NOT parse stdout — the OTel bridge handles all event mapping.
 */
export function spawnClaudeCode(input: ClaudeCodeSpawnInput): ClaudeCodeRuntimeHandle {
  const {
    sessionId = `cc-${randomUUID()}`,
    workspaceRoot,
    prompt,
    otelEndpoint,
    tenantId,
    projectId,
    userId,
    requestId,
    traceId = randomUUID(),
    timeoutMs = 600_000,
    claudePath = 'claude',
    extraArgs = [],
    env: extraEnv = {},
  } = input;

  // OTel env vars for Claude Code
  const otelEnv: Record<string, string> = {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',   // JSON over HTTP — directly parsable by our bridge
    OTEL_EXPORTER_OTLP_ENDPOINT: otelEndpoint,
    OTEL_METRIC_EXPORT_INTERVAL: '10000',    // 10s for metrics
    OTEL_LOGS_EXPORT_INTERVAL: '5000',       // 5s for logs/events
    // Resource attributes to identify this session
    OTEL_RESOURCE_ATTRIBUTES: [
      `session.id=${sessionId}`,
      tenantId ? `los.tenant_id=${tenantId}` : '',
      projectId ? `los.project_id=${projectId}` : '',
      userId ? `los.user_id=${userId}` : '',
      requestId ? `los.request_id=${requestId}` : '',
      `los.trace_id=${traceId}`,
      'los.source=claude-code',
    ].filter(Boolean).join(','),
    // Enable tool detail logging for full observability
    OTEL_LOG_TOOL_DETAILS: '1',
    // Inherit trace context
    TRACEPARENT: `00-${traceId}-${randomUUID().replace(/-/g, '').slice(0, 16)}-01`,
  };

  // Warn if OTel support is uncertain
  if (!claudeCodeSupportsOtel(claudePath)) {
    log.warn(
      `Claude Code version check failed or version < 1.0. OTel telemetry may not be emitted. ` +
      `Ensure CLAUDE_CODE_ENABLE_TELEMETRY is supported.`
    );
  }

  const args = [
    '-p', prompt,
    '--print',             // Print final response to stdout
    '--output-format', 'text',
    ...extraArgs,
  ];

  log.info(`Spawning Claude Code: ${claudePath} ${args.join(' ')} (cwd: ${workspaceRoot})`);

  const proc: ChildProcess = spawn(resolveRuntimeCommand(claudePath), args, {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      ...otelEnv,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  });

  const outputLimitBytes = Math.max(4_096, Math.min(512_000, input.outputLimitBytes ?? 128_000));
  const retained: Buffer[] = [];
  let capturedBytes = 0;
  let totalBytes = 0;
  let stderrBytes = 0;
  let spawnFailed = false;
  proc.stdout?.on('data', (chunk: Buffer) => {
    totalBytes += chunk.byteLength;
    const remaining = outputLimitBytes - capturedBytes;
    if (remaining <= 0) return;
    const bounded = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
    retained.push(bounded);
    capturedBytes += bounded.byteLength;
  });
  proc.stderr?.on('data', (chunk: Buffer) => { stderrBytes += chunk.byteLength; });
  proc.on('error', () => { spawnFailed = true; });

  const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    proc.on('close', (exitCode, signal) => {
      log.info(`Claude Code exited: code=${exitCode}, signal=${signal ?? 'none'}, stdout=${capturedBytes}/${totalBytes}B, stderr=${stderrBytes}B`);
      resolve({ exitCode, signal });
    });
    proc.on('error', (err) => {
      log.error(`Claude Code process error: ${err.message}`);
      resolve({ exitCode: null, signal: null });
    });
  });

  return {
    sessionId,
    pid: proc.pid,
    kill: (signal) => proc.kill(signal),
    exited,
    output: exited.then(() => ({
      text: redactExternalSummaryText([Buffer.concat(retained).toString('utf8')]).values[0] ?? '',
      capturedBytes,
      totalBytes,
      stderrBytes,
      truncated: capturedBytes < totalBytes,
      spawnFailed,
    })),
  };
}

/**
 * Convenience: run Claude Code with the los OTel bridge.
 * Starts the bridge if it's not already running, spawns Claude Code,
 * and returns the handle + bridge stop function.
 */
export async function runClaudeCodeWithBridge(
  input: Omit<ClaudeCodeSpawnInput, 'otelEndpoint'> & { bridgePort?: number },
): Promise<{ handle: ClaudeCodeRuntimeHandle; bridgeStop: () => Promise<void> }> {
  // Dynamically import to avoid circular dependency
  const { startOtelBridge, isOtelBridgeRunning } = await import('./otel-bridge.js');

  let bridgeStop: () => Promise<void>;
  let otelEndpoint: string;

  if (isOtelBridgeRunning()) {
    otelEndpoint = `http://127.0.0.1:${input.bridgePort ?? 4318}`;
    bridgeStop = async () => {}; // Don't stop an externally-managed bridge
  } else {
    try {
      const bridge = await startOtelBridge({ port: input.bridgePort, source: 'claude-code' });
      otelEndpoint = `http://127.0.0.1:${bridge.port}`;
      bridgeStop = bridge.stop;
    } catch (error) {
      otelEndpoint = `http://127.0.0.1:${input.bridgePort ?? 4318}`;
      bridgeStop = async () => {};
      log.warn(`Claude Code OTel bridge unavailable; continuing without LOS OTel ingest: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const handle = spawnClaudeCode({ ...input, otelEndpoint });
  return { handle, bridgeStop };
}
