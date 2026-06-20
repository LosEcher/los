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

import { spawn, type ChildProcess, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { getLogger } from '@los/infra/logger';
import type { RuntimeAdapterConfig, RuntimeHandle } from './types.js';

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
}

/**
 * Check if claude CLI supports OTel natively.
 * Returns true if 'claude --version' succeeds and version >= 1.0.
 */
export function claudeCodeSupportsOtel(claudePath = 'claude'): boolean {
  try {
    const out = execSync(`${claudePath} --version`, { encoding: 'utf-8', timeout: 5_000 }).trim();
    // Claude Code version format: "Claude Code v1.x.x" or just "1.x.x"
    const versionMatch = out.match(/(\d+)\.(\d+)/);
    if (!versionMatch) return false;
    const major = Number(versionMatch[1]);
    return major >= 1;
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
export function spawnClaudeCode(input: ClaudeCodeSpawnInput): RuntimeHandle {
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

  const proc: ChildProcess = spawn(claudePath, args, {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      ...otelEnv,
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: timeoutMs,
  });

  // Collect stdout/stderr for debugging but don't parse them for events
  let stdout = '';
  let stderr = '';
  proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
  proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });

  const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    proc.on('close', (exitCode, signal) => {
      log.info(`Claude Code exited: code=${exitCode}, signal=${signal ?? 'none'}, stdout=${stdout.length}B, stderr=${stderr.length}B`);
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
  };
}

/**
 * Convenience: run Claude Code with the los OTel bridge.
 * Starts the bridge if it's not already running, spawns Claude Code,
 * and returns the handle + bridge stop function.
 */
export async function runClaudeCodeWithBridge(
  input: Omit<ClaudeCodeSpawnInput, 'otelEndpoint'> & { bridgePort?: number },
): Promise<{ handle: RuntimeHandle; bridgeStop: () => Promise<void> }> {
  // Dynamically import to avoid circular dependency
  const { startOtelBridge, isOtelBridgeRunning } = await import('./otel-bridge.js');

  let bridgeStop: () => Promise<void>;
  let otelEndpoint: string;

  if (isOtelBridgeRunning()) {
    otelEndpoint = `http://127.0.0.1:${input.bridgePort ?? 4318}`;
    bridgeStop = async () => {}; // Don't stop an externally-managed bridge
  } else {
    const bridge = await startOtelBridge({ port: input.bridgePort, source: 'claude-code' });
    otelEndpoint = `http://127.0.0.1:${bridge.port}`;
    bridgeStop = bridge.stop;
  }

  const handle = spawnClaudeCode({ ...input, otelEndpoint });
  return { handle, bridgeStop };
}
